/*
 * DevProxy -- a minimal HTTP CONNECT proxy that forwards through a SOCKS5 proxy.
 *
 * Why this exists: Gradle's HTTP client installs its own route planner and, on a
 * host whose only route to the internet is a SOCKS5 proxy (HTTPS_PROXY set to a
 * socks5:// URL), it connects directly instead of through the proxy. Maven Central
 * happens to be reachable directly, so the failure surfaces late and confusingly
 * as "Remote host terminated the handshake" for dl.google.com only.
 *
 * Gradle *does* honour the documented HTTP proxy settings, so this bridge speaks
 * plain HTTP CONNECT to Gradle and dials the target itself: through the SOCKS proxy
 * for hosts that are only reachable that way (dl.google.com), and directly for
 * hosts that the SOCKS route cannot reach (repo.maven.apache.org). Gradle's own
 * nonProxyHosts handling is not used, so the decision lives in one place.
 *
 *   java -DsocksProxyHost=127.0.0.1 -DsocksProxyPort=20170 DevProxy.java 20180 [*.maven.apache.org,repo1.maven.org]
 *
 * then point Gradle at it (tools/setup-toolchain.sh does this automatically):
 *   systemProp.https.proxyHost=127.0.0.1
 *   systemProp.https.proxyPort=20180
 */
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class DevProxy {

    /** Host patterns that must be dialled directly instead of through SOCKS. */
    private static String[] directPatterns = {"*.maven.apache.org", "repo1.maven.org", "localhost", "127.*", "[::1]"};

    public static void main(String[] args) throws IOException {
        int port = args.length > 0 ? Integer.parseInt(args[0]) : 20180;
        if (args.length > 1 && !args[1].isBlank()) {
            directPatterns = args[1].split(",");
        }
        ServerSocket server = new ServerSocket(port, 100, InetAddress.getByName("127.0.0.1"));
        System.out.println("DevProxy listening on 127.0.0.1:" + port
                + " socksProxyHost=" + System.getProperty("socksProxyHost")
                + " socksProxyPort=" + System.getProperty("socksProxyPort"));
        System.out.flush();
        ExecutorService pool = Executors.newCachedThreadPool();
        while (true) {
            Socket client = server.accept();
            pool.execute(() -> handle(client));
        }
    }

    private static void handle(Socket client) {
        try (client) {
            client.setSoTimeout(180_000);
            client.setTcpNoDelay(true);
            String requestLine = readLine(client.getInputStream());
            if (requestLine == null) return;
            String[] parts = requestLine.split(" ");
            String header;
            while ((header = readLine(client.getInputStream())) != null && !header.isEmpty()) {
                // Headers are irrelevant for a CONNECT tunnel.
            }
            if (parts.length < 2 || !"CONNECT".equalsIgnoreCase(parts[0])) {
                write(client.getOutputStream(), "HTTP/1.1 501 Only CONNECT is supported\r\n\r\n");
                return;
            }
            String hostPort = parts[1];
            int colon = hostPort.lastIndexOf(':');
            if (colon < 0) {
                write(client.getOutputStream(), "HTTP/1.1 400 Bad Request\r\n\r\n");
                return;
            }
            String host = hostPort.substring(0, colon);
            int port = Integer.parseInt(hostPort.substring(colon + 1));

            try (Socket upstream = dial(host, port)) {
                upstream.setTcpNoDelay(true);
                upstream.setSoTimeout(180_000);
                write(client.getOutputStream(), "HTTP/1.1 200 Connection Established\r\n\r\n");
                Thread up = new Thread(() -> copy(upstream, client), "devproxy-up");
                up.setDaemon(true);
                up.start();
                copy(client, upstream);
            }
        } catch (Exception ignored) {
            // Connection-level failures (timeouts, resets) are expected and normal.
        }
    }

    /**
     * SOCKS for the general case, a direct socket for hosts the SOCKS route cannot
     * serve. {@code Proxy.NO_PROXY} is what bypasses the JVM-wide socksProxyHost
     * setting for a single socket.
     */
    private static Socket dial(String host, int port) throws IOException {
        boolean direct = false;
        for (String pattern : directPatterns) {
            if (matches(pattern.trim(), host)) {
                direct = true;
                break;
            }
        }
        Socket socket = direct ? new Socket(Proxy.NO_PROXY) : new Socket();
        socket.connect(new InetSocketAddress(host, port), 45_000);
        return socket;
    }

    private static boolean matches(String pattern, String host) {
        if (pattern.isEmpty()) return false;
        if (pattern.startsWith("*")) return host.endsWith(pattern.substring(1));
        if (pattern.endsWith("*")) return host.startsWith(pattern.substring(0, pattern.length() - 1));
        return host.equalsIgnoreCase(pattern);
    }

    private static void copy(Socket from, Socket to) {
        byte[] buffer = new byte[32 * 1024];
        try {
            InputStream in = from.getInputStream();
            OutputStream out = to.getOutputStream();
            int read;
            while ((read = in.read(buffer)) != -1) {
                out.write(buffer, 0, read);
                out.flush();
            }
        } catch (IOException ignored) {
            // The other side closed the tunnel.
        } finally {
            try {
                to.shutdownOutput();
            } catch (IOException ignored) {
                // ignore
            }
        }
    }

    private static String readLine(InputStream in) throws IOException {
        StringBuilder line = new StringBuilder(128);
        int read;
        while ((read = in.read()) != -1) {
            if (read == '\n') return line.toString().trim();
            if (read != '\r') line.append((char) read);
            if (line.length() > 8192) throw new IOException("header line too long");
        }
        return line.length() == 0 ? null : line.toString();
    }

    private static void write(OutputStream out, String text) throws IOException {
        out.write(text.getBytes(StandardCharsets.ISO_8859_1));
        out.flush();
    }
}
