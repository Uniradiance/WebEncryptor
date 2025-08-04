#!/usr/bin/env python
# -*- coding: utf-8 -*-

import datetime
from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives import serialization

def generate_certificate(args):
    """根据提供的参数生成证书和私钥"""
    
    # --- 固定的参数 (根据你的要求，这些不从终端输入) ---
    private_key_filename = "cert/key.pem"
    public_cert_filename = "cert/cert.pem"
    public_exponent = 65537
    key_size = 2048
    
    # 1. 生成私钥
    print("正在生成 2048 位 RSA 私钥...")
    private_key = rsa.generate_private_key(
        public_exponent=public_exponent,
        key_size=key_size,
    )

    # 2. 定义证书的主题和颁发者 (对于自签名证书，它们是相同的)
    #    这里使用了从命令行传入的参数
    subject = issuer = x509.Name([
        x509.NameAttribute(NameOID.COUNTRY_NAME, args.country),
        x509.NameAttribute(NameOID.STATE_OR_PROVINCE_NAME, args.state),
        x509.NameAttribute(NameOID.LOCALITY_NAME, args.locality),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, args.org),
        x509.NameAttribute(NameOID.COMMON_NAME, args.cn),
    ])

    # 3. 构建证书
    print(f"正在为通用名称 (CN) '{args.cn}' 构建证书...")
    builder = x509.CertificateBuilder().subject_name(
        subject
    ).issuer_name(
        issuer
    ).public_key(
        private_key.public_key()
    ).serial_number(
        x509.random_serial_number()
    ).not_valid_before(
        datetime.datetime.now(datetime.timezone.utc)
    ).not_valid_after(
        # 证书有效期从命令行参数获取
        datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=args.days)
    )

    # 添加 SAN (Subject Alternative Name) 扩展，现代浏览器强制要求
    # 允许多个SAN，例如 --san localhost --san 127.0.0.1
    if args.san:
        print(f"添加主题备用名称 (SAN): {', '.join(args.san)}")
        builder = builder.add_extension(
            x509.SubjectAlternativeName([x509.DNSName(name) for name in args.san]),
            critical=False,
        )

    # 4. 使用私钥签名证书
    certificate = builder.sign(private_key, hashes.SHA256())

    # 5. 将私钥和证书写入文件 (PEM 格式)
    print(f"正在将私钥写入 '{private_key_filename}'...")
    with open(private_key_filename, "wb") as f:
        f.write(private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        ))

    print(f"正在将证书写入 '{public_cert_filename}'...")
    with open(public_cert_filename, "wb") as f:
        f.write(certificate.public_bytes(serialization.Encoding.PEM))

    print("\n✅ 操作成功！")
    print(f"   私钥文件: {private_key_filename}")
    print(f"   证书文件: {public_cert_filename}")
