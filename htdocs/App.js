import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { ROWS, COLS, COL_LABELS, ROW_LABELS, COLOR_SEQUENCE } from './constants.js'; // Added .js
import Cell from './Cell.js'; // Added .js
import { compareCellIds } from './sortUtils.js'; // Added .js
// Removed: import { CellData, CellColor } from './types';

const SYNTHETIC_MOUSE_EVENT_THRESHOLD_MS = 100;
// 全局变量存储 React 组件的引用
window.reactAppRef = {
  current: null
};

// Style constants in REM
const GRID_GAP_REM = 0.25;
const GRID_PADDING_REM = 0.5;
const ROW_LABEL_WIDTH_REM = 2;
const COL_LABEL_HEIGHT_REM = 2;
const LABELS_CONTAINER_MARGIN_REM = 0.25; // Margin between row/col labels container and the grid container

// SVG Icon Components
const UndoIcon = ({ color = 'currentColor', size = 20 }) => (
  React.createElement('svg', {
    xmlns: "http://www.w3.org/2000/svg", height: `${size}px`, viewBox: "0 0 24 24", width: `${size}px`, fill: color, 'aria-hidden': "true"
  },
    React.createElement('path', { d: "M0 0h24v24H0V0z", fill: "none" }),
    React.createElement('path', { d: "M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z" })
  )
);

const ResetIcon = ({ color = 'currentColor', size = 20 }) => (
  React.createElement('svg', {
    xmlns: "http://www.w3.org/2000/svg", height: `${size}px`, viewBox: "0 0 24 24", width: `${size}px`, fill: color, 'aria-hidden': "true"
  },
    React.createElement('path', { d: "M0 0h24v24H0V0z", fill: "none" }),
    React.createElement('path', { d: "M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" })
  )
);

const CopyIcon = ({ color = 'currentColor', size = 20 }) => (
  React.createElement('svg', {
    xmlns: "http://www.w3.org/2000/svg", height: `${size}px`, viewBox: "0 0 24 24", width: `${size}px`, fill: color, 'aria-hidden': "true"
  },
    React.createElement('path', { d: "M0 0h24v24H0V0z", fill: "none" }),
    React.createElement('path', { d: "M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z" })
  )
);

const PasteIcon = ({ color = 'currentColor', size = 20 }) => (
  React.createElement('svg', {
    xmlns: "http://www.w3.org/2000/svg", height: `${size}px`, viewBox: "0 0 24 24", width: `${size}px`, fill: color, 'aria-hidden': "true"
  },
    React.createElement('path', { d: "M0 0h24v24H0V0z", fill: "none" }),
    React.createElement('path', { d: "M19 2h-4.18C14.4.84 13.3 0 12 0S9.6.84 9.18 2H5c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm7 18H5V4h2v3h10V4h2v16z" })
  )
);

const App = () => {
  const initialCells = useCallback(() => {
    return Array.from({ length: ROWS }, (_, r) =>
      Array.from({ length: COLS }, (_, c) => ({
        id: `${COL_LABELS[c]}${ROW_LABELS[r]}`,
        row: r,
        col: c,
        color: null,
      }))
    );
  }, []);

  const [cells, setCells] = useState(initialCells());
  const [displayCells, setDisplayCells] = useState(initialCells());
  const [isPressing, setIsPressing] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [interactionOriginCell, setInteractionOriginCell] = useState(null);
  const [nextColorForOriginOrDrag, setNextColorForOriginOrDrag] = useState(undefined);

  const [dynamicFooterFontSize, setDynamicFooterFontSize] = useState('0.875rem');

  const isPressingRef = useRef(false);
  const lastInteractionTypeRef = useRef(null);
  const lastInteractionTimeRef = useRef(0);

  const actualGridRef = useRef(null);
  const [dynamicCellSize, setDynamicCellSize] = useState(null); // Will be in pixels

  const [undoHovered, setUndoHovered] = useState(false);
  const [resetHovered, setResetHovered] = useState(false);
  const [copyHovered, setCopyHovered] = useState(false);
  const [pasteHovered, setPasteHovered] = useState(false);

  const remToPx = useCallback((remValue) => {
    if (typeof window === 'undefined' || typeof getComputedStyle === 'undefined' || !document.documentElement) return remValue * 16; // Fallback
    return remValue * parseFloat(getComputedStyle(document.documentElement).fontSize);
  }, []);

  useEffect(() => {
    setDisplayCells(cells);
  }, [cells]);

  useEffect(() => {
    const calculateCellSize = () => {
      if (actualGridRef.current) {
        const gridElement = actualGridRef.current;

        const gridGapPx = remToPx(GRID_GAP_REM);

        const cs = window.getComputedStyle(gridElement);
        const gridPaddingLeftPx = parseFloat(cs.paddingLeft) || 0;
        const gridPaddingRightPx = parseFloat(cs.paddingRight) || 0;

        const netGridContentsWidth = gridElement.offsetWidth - gridPaddingLeftPx - gridPaddingRightPx;
        const totalGapWidth = (COLS - 1) * gridGapPx;
        const calculatedSize = (netGridContentsWidth - totalGapWidth) / COLS;

        setDynamicCellSize(calculatedSize > 0 ? calculatedSize : null);
      }
    };

    calculateCellSize();

    const observer = new ResizeObserver(calculateCellSize);
    if (actualGridRef.current) {
      observer.observe(actualGridRef.current);
    }

    // Initial calculation after mount, and on window resize
    window.addEventListener('resize', calculateCellSize);

    return () => {
      window.removeEventListener('resize', calculateCellSize);
      if (actualGridRef.current && observer) {
        observer.unobserve(actualGridRef.current);
      }
    };
  }, [COLS, remToPx]); // remToPx is stable, COLS is constant

  useEffect(() => {
    const handleResizeFooterFont = () => {
      if (window.innerWidth < 768) { // Breakpoint for smaller screens
        const size = `${window.innerWidth * 0.001}rem`;
        setDynamicFooterFontSize(size); // Smaller font size
      } else {
        setDynamicFooterFontSize('0.875rem'); // Default font size
      }
    };

    window.addEventListener('resize', handleResizeFooterFont);
    handleResizeFooterFont(); // Call on initial mount to set the correct size

    return () => window.removeEventListener('resize', handleResizeFooterFont);
  }, []);

  const updateCellColor = useCallback((row, col, newColor, timestamp) => {
    setCells(prevCells => {
      const newCells = prevCells.map(r => r.map(c => ({ ...c })));
      const targetCell = newCells[row][col];
      targetCell.color = newColor;
      if (newColor !== null && timestamp) {
        targetCell.lastSetTimestamp = timestamp;
      } else if (newColor === null) {
        delete targetCell.lastSetTimestamp;
      }
      return newCells;
    });
  }, []);

  const handleCellInteractionStart = useCallback((row, col, type) => {
    const currentTime = Date.now();

    if (type === 'mouse' &&
      lastInteractionTypeRef.current === 'touchend' &&
      (currentTime - lastInteractionTimeRef.current < SYNTHETIC_MOUSE_EVENT_THRESHOLD_MS)) {
      return;
    }
    if (isPressingRef.current) return;

    isPressingRef.current = true;
    setIsPressing(true);

    const cell = cells[row][col];
    setInteractionOriginCell({ row, col, id: cell.id });

    let nextColor;
    switch (cell.color) {
      case null: nextColor = 'RED'; break;
      case 'RED': nextColor = 'GREEN'; break;
      case 'GREEN': nextColor = 'BLUE'; break;
      case 'BLUE': nextColor = 'BLACK'; break;
      case 'BLACK': nextColor = null; break;
      default: nextColor = 'RED'; break;
    }
    setNextColorForOriginOrDrag(nextColor);

    lastInteractionTypeRef.current = type;
    lastInteractionTimeRef.current = currentTime;

  }, [cells]);

  const handlePointerMoveOverCell = useCallback((row, col, id) => {
    if (isPressingRef.current && interactionOriginCell && id !== interactionOriginCell.id) {
      const originCellState = cells[interactionOriginCell.row][interactionOriginCell.col];
      const dragPaintColor = originCellState.color;
      if (dragPaintColor === null) return false;
      if (!isDragging) setIsDragging(true);

      if (cells[row][col].color !== dragPaintColor) {
        updateCellColor(row, col, dragPaintColor, Date.now());
      }
      return true;
    }
    return false;
  }, [isDragging, interactionOriginCell, cells, updateCellColor]);

  const generateFullDataString = useCallback(() => {
    const coloredCells = [];
    cells.flat().forEach(cell => {
      if (cell.color !== null && cell.lastSetTimestamp) {
        coloredCells.push(cell);
      }
    });
    coloredCells.sort((a, b) => (a.lastSetTimestamp || 0) - (b.lastSetTimestamp || 0));
    const data = coloredCells.map(cell => `${cell.color}${cell.id}`).join('');
    return data;
  }, [cells]);

  const generateHalfDataString = useCallback((isUpperHalf) => {
    const targetRows = isUpperHalf ? [0, 1, 2] : [3, 4, 5];
    const halfCells = [];

    cells.flat().forEach(cell => {
      if (cell.color !== null && targetRows.includes(cell.row)) {
        halfCells.push(cell);
      }
    });

    halfCells.sort((a, b) => compareCellIds(a.id, b.id));
    const data = halfCells.map(cell => `${cell.color}${cell.id}`).join('');

    return data;
  }, [cells]);

  const shuffleCellColors = useCallback(() => {
    const availableColors = COLOR_SEQUENCE;
    const newDisplayCells = Array.from({ length: ROWS }, (_, r) =>
      Array.from({ length: COLS }, (_, c) => ({
        id: `${COL_LABELS[c]}${ROW_LABELS[r]}`,
        row: r,
        col: c,
        color: availableColors[Math.floor(Math.random() * (availableColors.length - 2) + 1)],
      }))
    );
    setDisplayCells(newDisplayCells);
  }, []);


  useEffect(() => {
    const handleGlobalInteractionEnd = (event) => {
      const currentTime = Date.now();
      if (event.type === 'touchend' || event.type === 'touchcancel') {
        lastInteractionTypeRef.current = 'touchend';
        lastInteractionTimeRef.current = currentTime;
      } else if (event.type === 'mouseup') {
        lastInteractionTypeRef.current = 'mouseup';
        lastInteractionTimeRef.current = currentTime;
      }

      if (isPressingRef.current && interactionOriginCell) {
        if (!isDragging) {
          let targetCellElement = null;
          let eventProcessedForClick = false;

          if (event.type === 'mouseup' && event.target instanceof HTMLElement) {
            targetCellElement = event.target;
            eventProcessedForClick = true;
          } else if (event.type === 'touchend' || event.type === 'touchcancel') {
            const touchEvent = event;
            if (touchEvent.changedTouches && touchEvent.changedTouches.length > 0) {
              const touch = touchEvent.changedTouches[0];
              const elementFromPoint = document.elementFromPoint(touch.clientX, touch.clientY);
              if (elementFromPoint instanceof HTMLElement) targetCellElement = elementFromPoint;
              eventProcessedForClick = true;
            } else if (event.type === 'touchcancel' && !touchEvent.changedTouches?.length) {
              const originCellFromDom = document.querySelector(`[data-row="${interactionOriginCell.row}"][data-col="${interactionOriginCell.col}"]`);
              if (originCellFromDom instanceof HTMLElement) targetCellElement = originCellFromDom;
              eventProcessedForClick = true;
            }
          }

          if (eventProcessedForClick && targetCellElement) {
            let clickedOnOrigin = false;
            const closestCell = targetCellElement.closest('[data-cell="true"]');
            if (closestCell instanceof HTMLElement) {
              const rowStr = closestCell.dataset.row;
              const colStr = closestCell.dataset.col;
              if (rowStr && colStr) {
                const r = parseInt(rowStr, 10);
                const c = parseInt(colStr, 10);
                if (r === interactionOriginCell.row && c === interactionOriginCell.col) {
                  clickedOnOrigin = true;
                }
              }
            }

            if (clickedOnOrigin && nextColorForOriginOrDrag !== undefined) {
              updateCellColor(interactionOriginCell.row, interactionOriginCell.col, nextColorForOriginOrDrag, nextColorForOriginOrDrag !== null ? Date.now() : undefined);
            }
          }
        }
      }

      isPressingRef.current = false;
      setIsPressing(false);
      setIsDragging(false);
      setInteractionOriginCell(null);
      setNextColorForOriginOrDrag(undefined);
    };

    const handleDocumentTouchMove = (event) => {
      if (!isPressingRef.current || !interactionOriginCell) return;

      const touch = event.touches[0];
      const targetElement = document.elementFromPoint(touch.clientX, touch.clientY);

      if (targetElement instanceof HTMLElement && targetElement.dataset.cell === "true") {
        const rowStr = targetElement.dataset.row;
        const colStr = targetElement.dataset.col;

        if (rowStr && colStr) {
          const r = parseInt(rowStr, 10);
          const c = parseInt(colStr, 10);
          const cellId = COL_LABELS[c] + ROW_LABELS[r];

          if (handlePointerMoveOverCell(r, c, cellId)) {
            if (event.cancelable) event.preventDefault();
          }
        }
      }
    };

    document.addEventListener('mouseup', handleGlobalInteractionEnd);
    document.addEventListener('touchend', handleGlobalInteractionEnd);
    document.addEventListener('touchcancel', handleGlobalInteractionEnd);
    document.addEventListener('touchmove', handleDocumentTouchMove, { passive: false });

    window.reactAppRef.current = {
      getFullData: generateFullDataString,
      getHalfData: generateHalfDataString,
      getCells: () => [...cells],
      shuffleCellColors: shuffleCellColors,
    };

    return () => {
      document.removeEventListener('mouseup', handleGlobalInteractionEnd);
      document.removeEventListener('touchend', handleGlobalInteractionEnd);
      document.removeEventListener('touchcancel', handleGlobalInteractionEnd);
      document.removeEventListener('touchmove', handleDocumentTouchMove);
    };
  }, [isDragging, interactionOriginCell, nextColorForOriginOrDrag, handlePointerMoveOverCell, updateCellColor, cells, COL_LABELS, ROW_LABELS, generateFullDataString, generateHalfDataString, shuffleCellColors]);

  // 使用 useMemo 缓存计算结果，避免不必要的重复计算
  const hasActiveCells = useMemo(() => {
    return cells.flat().some(cell =>
      cell.color !== null && cell.lastSetTimestamp
    );
  }, [cells]); // 依赖 cells 状态

  const handleUndo = useCallback(() => {
    const coloredCells = [];
    cells.flat().forEach(cell => {
      if (cell.color !== null && cell.lastSetTimestamp) {
        coloredCells.push(cell);
      }
    });
    coloredCells.sort((a, b) => (a.lastSetTimestamp || 0) - (b.lastSetTimestamp || 0));

    if (coloredCells.length > 0) {
      const newCells = cells.map(r =>
        r.map(c => {
          // 创建单元格的浅拷贝
          const cell = { ...c };

          // 检查当前单元格是否是目标单元格
          if (cell.id === coloredCells[coloredCells.length - 1].id) {
            // 对目标单元格进行特殊处理
            cell.color = null;
          }

          return cell;
        })
      );
      setCells(newCells);
    }

  }, [cells]);

  const handleReset = useCallback(() => {
    setCells(initialCells());
  }, [initialCells]);

  const handleCopy = useCallback(async () => {
    try {
      const cellsJson = JSON.stringify(cells);
      await navigator.clipboard.writeText(cellsJson);
    } catch (err) {
      console.error('Failed to copy grid data: ', err);
      alert('Failed to copy grid data.');
    }
  }, [cells]);

  const handlePaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      const parsedCells = JSON.parse(text);
      if (Array.isArray(parsedCells) && parsedCells.length === ROWS &&
        parsedCells.every(row => Array.isArray(row) && row.length === COLS &&
          row.every(cell => typeof cell === 'object' && cell !== null &&
            'id' in cell && 'row' in cell && 'col' in cell && 'color' in cell))) {
        setCells(parsedCells);
        setTimeout(() => {
          shuffleCellColors();
        }, 1000);
      } else {
        throw new Error('Invalid data format pasted.');
      }
    } catch (err) {
      console.error('Failed to paste grid data: ', err);
    }
  }, []); // Removed createInitialCells from deps as it's not used for re-init on paste

  // Styles
  const appStyle = {
    minHeight: '10vh',
    padding: '1rem',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    boxSizing: 'border-box',
    overflowX: 'hidden',
  };

  const gridAndControlsContainerStyle = {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: '2rem',
    marginBottom: '2rem',
    width: '100%',
  };

  const actionsPanelStyle = {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
    paddingLeft: '0.5rem',
    minWidth: '50px', // Minimum width for the actions panel
    flexShrink: 0, // Prevent this panel from shrinking in flex layout
    alignItems: 'flex-start',
  };


  const mainGridContainerStyle = {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0, // Crucial for allowing this container to shrink
  };

  const colLabelsContainerStyle = {
    display: 'flex',
    alignItems: 'center',
    marginBottom: `${LABELS_CONTAINER_MARGIN_REM}rem`,
    paddingLeft: `calc(${ROW_LABEL_WIDTH_REM}rem + ${LABELS_CONTAINER_MARGIN_REM}rem + ${GRID_PADDING_REM}rem)`,
    boxSizing: 'border-box',
    width: '100%',
    minWidth: '100rem',
  };

  const baseLabelStyle = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '0.875rem',
    fontWeight: '500',
    color: '#9CA3AF',
    boxSizing: 'border-box',
  };

  const colLabelStyle = (isLast) => ({
    ...baseLabelStyle,
    width: dynamicCellSize ? `${dynamicCellSize}px` : `${remToPx(4)}px`, // Dynamic width
    height: `${COL_LABEL_HEIGHT_REM}rem`,
    marginRight: isLast ? '0px' : `${remToPx(GRID_GAP_REM)}px`, // Use calculated pixel value for gap
  });

  const rowLabelsContainerStyle = {
    display: 'flex',
    flexDirection: 'column',
    marginRight: `${LABELS_CONTAINER_MARGIN_REM}rem`,
    paddingTop: `${GRID_PADDING_REM}rem`,
    flexShrink: 0,
  };

  const rowLabelStyle = (isLast) => ({
    ...baseLabelStyle,
    width: `${ROW_LABEL_WIDTH_REM}rem`,
    height: dynamicCellSize ? `${dynamicCellSize}px` : `${remToPx(4)}px`, // Dynamic height
    marginBottom: isLast ? '0px' : `${remToPx(GRID_GAP_REM)}px`, // Consistent pixel gap
  });

  const gridAndRowLabelsFlexContainer = {
    display: 'flex',
    flex: 1, // Takes available vertical space in gridSectionContainerStyle
    minHeight: 0, // Important for flex children in a container that might shrink
  };

  const actualGridStyle = {
    display: 'grid',
    gridTemplateColumns: `repeat(${COLS}, 1fr)`,
    gap: `${GRID_GAP_REM}rem`,
    padding: `${GRID_PADDING_REM}rem`,
    backgroundColor: 'rgb(191 227 255)',
    borderRadius: '0.1rem',
    boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -2px rgba(0,0,0,0.05)',
    flex: 1, // Takes available horizontal space in gridAndRowLabelsFlexContainer
    aspectRatio: '1 / 1',
    minWidth: '200px', // Minimum size for the grid
    minHeight: '200px', // Minimum size for the grid
    boxSizing: 'border-box',
  };

  const actionIconButtonStyle = (disabled = false, hovered = false) => ({
    backgroundColor: hovered && !disabled ? 'rgba(129, 140, 248, 0.15)' : 'transparent', // Subtle hover background
    color: disabled ? '#6B7280' : (hovered ? '#A5B4FC' : '#818CF8'), // For SVG fill="currentColor"
    padding: '0.5rem',
    border: 'none',
    borderRadius: '0.375rem', // Rounded corners for the button
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1, // Slightly more pronounced opacity for disabled
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'background-color 0.15s ease-in-out, color 0.15s ease-in-out',
    width: '36px', // Ensuring buttons are square and consistently sized
    height: '36px',
  });

  const footerStyle = {
    textAlign: 'center',
    color: '#6B7280',
    fontSize: dynamicFooterFontSize,
  };

  const iconSize = 20;

  return (
    React.createElement('div', { style: appStyle },
      React.createElement('div', { style: gridAndControlsContainerStyle },
        React.createElement('div', { style: mainGridContainerStyle },
          React.createElement('div', { style: colLabelsContainerStyle },
            COL_LABELS.map((label, index) => (
              React.createElement('div', {
                key: label,
                style: colLabelStyle(index === COL_LABELS.length - 1)
              }, label)
            ))
          ),
          React.createElement('div', { style: gridAndRowLabelsFlexContainer },
            React.createElement('div', { style: rowLabelsContainerStyle },
              ROW_LABELS.map((label, index) => (
                React.createElement('div', {
                  key: label,
                  style: rowLabelStyle(index === ROW_LABELS.length - 1)
                }, label)
              ))
            ),
            React.createElement('div', { style: actualGridStyle, ref: actualGridRef },
              displayCells.map((row) =>
                row.map((cellData) => (
                  React.createElement(Cell, {
                    key: cellData.id,
                    cellData: cellData,
                    onInteractionStart: handleCellInteractionStart,
                    onPointerEnter: handlePointerMoveOverCell,
                  })
                ))
              )
            ),
            React.createElement('div', { style: actionsPanelStyle },
              React.createElement('button', {
                onClick: handleUndo,
                style: actionIconButtonStyle(!hasActiveCells, undoHovered),
                onMouseEnter: () => setUndoHovered(true),
                onMouseLeave: () => setUndoHovered(false),
                'aria-label': "Undo cell change",
                title: "Undo Change",
                disabled: !hasActiveCells,
              }, React.createElement(UndoIcon, { size: iconSize })),
              React.createElement('button', {
                onClick: handleReset,
                style: actionIconButtonStyle(!hasActiveCells, resetHovered),
                onMouseEnter: () => setResetHovered(true),
                onMouseLeave: () => setResetHovered(false),
                'aria-label': "Reset entire grid",
                title: "Reset Grid",
                disabled: !hasActiveCells,
              }, React.createElement(ResetIcon, { size: iconSize })),
              React.createElement('button', {
                onClick: handleCopy,
                style: actionIconButtonStyle(!hasActiveCells, copyHovered),
                onMouseEnter: () => setCopyHovered(true),
                onMouseLeave: () => setCopyHovered(false),
                'aria-label': "Copy grid data to clipboard",
                title: "Copy Grid Data",
                disabled: !hasActiveCells,
              }, React.createElement(CopyIcon, { size: iconSize })),
              React.createElement('button', {
                onClick: handlePaste,
                style: actionIconButtonStyle(false, pasteHovered),
                onMouseEnter: () => setPasteHovered(true),
                onMouseLeave: () => setPasteHovered(false),
                'aria-label': "Paste grid data from clipboard",
                title: "Paste Grid Data"
              }, React.createElement(PasteIcon, { size: iconSize }))
            )
          )
        )
      ),
      React.createElement('footer', { style: footerStyle },
        React.createElement('p', null, 'Tap/click cells to change color. Tap/click and drag to paint multiple cells.'),
        React.createElement('p', null, 'Color cycle: Default \u2192 Red \u2192 Green \u2192 Blue \u2192 Black \u2192 Default.'),
        React.createElement('p', null, 'Dragging paints with the cell\'s current color. Dragging from an empty (Default/White) cell is disabled.')
      )
    )
  );
};

export default App;