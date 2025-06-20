import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ROWS, COLS, COL_LABELS, ROW_LABELS } from './constants.js'; // Added .js
import Cell from './Cell.js'; // Added .js
import { compareCellIds } from './sortUtils.js'; // Added .js
// Removed: import { CellData, CellColor } from './types';

const SYNTHETIC_MOUSE_EVENT_THRESHOLD_MS = 100;
// 全局变量存储 React 组件的引用
window.reactAppRef = {
  current: null
};

const App = () => {
  const initialCells = () => {
    return Array.from({ length: ROWS }, (_, r) =>
      Array.from({ length: COLS }, (_, c) => ({
        id: `${COL_LABELS[c]}${ROW_LABELS[r]}`,
        row: r,
        col: c,
        color: null,
      }))
    );
  };

  const [cells, setCells] = useState(initialCells());
  const [isPressing, setIsPressing] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [interactionOriginCell, setInteractionOriginCell] = useState(null);
  const [nextColorForOriginOrDrag, setNextColorForOriginOrDrag] = useState(undefined);

  const isPressingRef = useRef(false);
  const lastInteractionTypeRef = useRef(null);
  const lastInteractionTimeRef = useRef(0);

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

    if (isPressingRef.current) {
      return;
    }
    
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

      if (dragPaintColor === null) { 
        return false; 
      }

      if (!isDragging) {
        setIsDragging(true);
      }
      
      if (cells[row][col].color !== dragPaintColor) {
        updateCellColor(row, col, dragPaintColor, Date.now());
      }
      return true; 
    }
    return false;
  }, [isDragging, interactionOriginCell, cells, updateCellColor]);

  const  generateFullDataString = () => {
    const coloredCells = [];
    cells.flat().forEach(cell => {
      if (cell.color !== null && cell.lastSetTimestamp) {
        coloredCells.push(cell);
      }
    });
    coloredCells.sort((a, b) => (a.lastSetTimestamp || 0) - (b.lastSetTimestamp || 0));
    const data = coloredCells.map(cell => `${cell.color}${cell.id}`).join('');
    return data;
  }

  const  generateHalfDataString = (isUpperHalf) => {
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
  }

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
      getFullData:generateFullDataString,
      getHalfData: generateHalfDataString,
      getCells: () => [...cells],
    };

    return () => {
      document.removeEventListener('mouseup', handleGlobalInteractionEnd);
      document.removeEventListener('touchend', handleGlobalInteractionEnd);
      document.removeEventListener('touchcancel', handleGlobalInteractionEnd);
      document.removeEventListener('touchmove', handleDocumentTouchMove); 
      window.reactAppRef.current = null;
    };
  }, [isDragging, interactionOriginCell, nextColorForOriginOrDrag, handlePointerMoveOverCell, updateCellColor, cells]);

  const appStyle = {
    minHeight: '10vh',
    padding: '1rem',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
  };

  const h1Style = {
    fontSize: '2.25rem',
    fontWeight: 'bold',
    marginBottom: '2rem',
    letterSpacing: '0.05em',
  };

  const mainGridContainerStyle = {
    marginBottom: '2rem',
  };

  const colLabelsContainerStyle = {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: '0.25rem',
    marginLeft: '2rem', 
  };
  
  const labelStyle = {
    width: '4rem', 
    height: '2rem', 
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '0.875rem', 
    fontWeight: '500', 
    color: '#9CA3AF', 
  };

  const rowLabelSpecificStyle = {
    ...labelStyle,
    width: '2rem', 
    height: '4rem', 
  };

  const gridAndRowLabelsFlexContainer = {
    display: 'flex',
  };

  const rowLabelsContainerStyle = {
    display: 'flex',
    flexDirection: 'column',
    marginRight: '0.25rem',
  };
  
  const actualGridStyle = {
    display: 'grid',
    gridTemplateColumns: 'repeat(6, minmax(0, 1fr))', 
    gap: '0.1rem', 
    padding: '0.5rem', 
    backgroundColor: '#374151', 
    borderRadius: '0.1rem', 
    boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -2px rgba(0,0,0,0.05)', 
  };

  const buttonsContainerStyle = {
    display: 'grid',
    gridTemplateColumns: 'repeat(1, minmax(0, 1fr))', 
    gap: '1rem', 
    marginBottom: '2rem', 
    width: '100%',
    maxWidth: '56rem', 
  };

  const buttonBaseStyle = {
    color: 'white',
    fontWeight: '600', 
    padding: '0.75rem 1.5rem', 
    borderRadius: '0.5rem', 
    boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -1px rgba(0,0,0,0.06)', 
    transition: 'background-color 0.15s ease-in-out', 
    border: 'none',
    cursor: 'pointer',
  };

  const dataDisplayContainerStyle = {
    width: '100%',
    maxWidth: '56rem', 
  };
  
  const dataBoxStyle = {
    backgroundColor: '#374151', 
    padding: '1rem', 
    borderRadius: '0.5rem', 
    boxShadow: '0 1px 3px 0 rgba(0,0,0,0.1), 0 1px 2px 0 rgba(0,0,0,0.06)', 
    marginBottom: '1rem', 
  };

  const dataTitleBaseStyle = {
    fontSize: '1.125rem', 
    fontWeight: '600', 
    marginBottom: '0.5rem', 
  };
  
  const dataTextStyle = {
    fontSize: '0.875rem', 
    wordBreak: 'break-all', 
    fontFamily: 'monospace', 
  };

  const footerStyle = {
    textAlign: 'center',
    color: '#6B7280', 
    fontSize: '0.875rem', 
  };

  return (
    React.createElement('div', { style: appStyle },
      React.createElement('div', { style: mainGridContainerStyle },
        React.createElement('div', { style: colLabelsContainerStyle },
          COL_LABELS.map((label, index) => (
            React.createElement('div', { key: label, style: {...labelStyle, marginRight: index < COL_LABELS.length - 1 ? '0.25rem' : '0' } }, label)
          ))
        ),
        React.createElement('div', { style: gridAndRowLabelsFlexContainer },
          React.createElement('div', { style: rowLabelsContainerStyle },
            ROW_LABELS.map((label, index) => (
              React.createElement('div', { key: label, style: {...rowLabelSpecificStyle, marginBottom: index < ROW_LABELS.length - 1 ? '0.25rem' : '0' } }, label)
            ))
          ),
          React.createElement('div', { style: actualGridStyle },
            cells.map((row) =>
              row.map((cellData) => (
                React.createElement(Cell, {
                  key: cellData.id,
                  cellData: cellData,
                  onInteractionStart: handleCellInteractionStart,
                  onPointerEnter: handlePointerMoveOverCell,
                })
              ))
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