import React, { useState, useEffect, useCallback, useRef, useMemo, useReducer } from 'react';
import { ROWS, COLS, COL_LABELS, ROW_LABELS } from './constants.js'; // Added .js
import Cell from './Cell.js'; // Added .js
import { initialGrid, gridReducer, gridPath, orderedCells } from './grid_state.js';
import { compareCellIds } from './sortUtils.js'; // Added .js
// Removed: import { CellData, CellColor } from './types';

const SYNTHETIC_MOUSE_EVENT_THRESHOLD_MS = 100;
// Global reference to the React component for imperative access from other modules
window.reactAppRef = {
  current: null
};

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

const App = () => {
  const [gridState, dispatchGrid] = useReducer(gridReducer, undefined, initialGrid);
  const cells = gridState.cells;
  const [hidden, setHidden] = useState(false);
  const [locked, setLocked] = useState(false);
  const ordered = useMemo(() => orderedCells(cells), [cells]);
  const [isPressing, setIsPressing] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [interactionOriginCell, setInteractionOriginCell] = useState(null);
  const [nextColorForOriginOrDrag, setNextColorForOriginOrDrag] = useState(undefined);

  const isPressingRef = useRef(false);
  const lastInteractionTypeRef = useRef(null);
  const lastInteractionTimeRef = useRef(0);

  const updateCellColor = useCallback((row, col, color) => {
    dispatchGrid({ type: 'paint', row, col, color });
  }, []);

  const handleCellInteractionStart = useCallback((row, col, type) => {
    if (hidden || locked) return;
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

  }, [cells, hidden, locked]);

  const handlePointerMoveOverCell = useCallback((row, col, id) => {
    if (!hidden && !locked && isPressingRef.current && interactionOriginCell && id !== interactionOriginCell.id) {
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
  }, [isDragging, interactionOriginCell, cells, updateCellColor, hidden, locked]);

  const generateFullDataString = useCallback(() => gridPath(cells), [cells]);

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

      if (!hidden && !locked && isPressingRef.current && interactionOriginCell) {
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
      if (hidden || locked || !isPressingRef.current || !interactionOriginCell) return;

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
      hide: () => setHidden(true),
      setLocked,
      reset: () => { dispatchGrid({ type: 'reset' }); setHidden(false); },
    };

    return () => {
      document.removeEventListener('mouseup', handleGlobalInteractionEnd);
      document.removeEventListener('touchend', handleGlobalInteractionEnd);
      document.removeEventListener('touchcancel', handleGlobalInteractionEnd);
      document.removeEventListener('touchmove', handleDocumentTouchMove);
    };
  }, [isDragging, interactionOriginCell, nextColorForOriginOrDrag, handlePointerMoveOverCell, updateCellColor, cells, COL_LABELS, ROW_LABELS, generateFullDataString, generateHalfDataString, hidden, locked]);

  // Memoized so re-renders skip recalculation when nothing changed
  const hasActiveCells = useMemo(() => {
    return cells.flat().some(cell =>
      cell.color !== null && cell.lastSetTimestamp
    );
  }, [cells]); // depends on cells state

  const handleUndo = useCallback(() => dispatchGrid({ type: 'undo' }), []);
  const handleReset = useCallback(() => {
    dispatchGrid({ type: 'reset' });
    setHidden(false);
  }, []);

  return (
    React.createElement('div', { className: 'grid-app' },
      React.createElement('div', { className: 'grid-board-layout', style: { '--grid-cols': COLS, '--grid-rows': ROWS } },
        React.createElement('div', { className: 'grid-col-labels', 'aria-hidden': true },
          COL_LABELS.map(label => React.createElement('span', { key: label }, label))
        ),
        React.createElement('div', { className: 'grid-row-labels', 'aria-hidden': true },
          ROW_LABELS.map(label => React.createElement('span', { key: label }, label))
        ),
        React.createElement('div', { className: 'color-grid', role: 'grid', 'aria-label': 'Color path' },
          cells.flat().map(cellData => React.createElement(Cell, {
            key: cellData.id,
            cellData,
            hidden,
            disabled: hidden || locked,
            onInteractionStart: handleCellInteractionStart,
            onPointerEnter: handlePointerMoveOverCell,
          }))
        ),
        React.createElement('div', { className: 'grid-actions' },
          React.createElement('button', {
            type: 'button',
            onClick: handleUndo,
            className: 'grid-icon-button',
            'aria-label': 'Undo cell change',
            title: 'Undo Change',
            disabled: !gridState.history.length || hidden || locked,
          }, React.createElement(UndoIcon)),
          React.createElement('button', {
            type: 'button',
            onClick: handleReset,
            className: 'grid-icon-button',
            'aria-label': 'Reset entire grid',
            title: 'Reset Grid',
            disabled: !hasActiveCells || locked,
          }, React.createElement(ResetIcon))
        )
      ),
      React.createElement('div', { className: 'grid-status', role: 'status', 'aria-live': 'polite' },
        React.createElement('span', null, hidden ? 'Grid hidden · selection retained' :
          ordered.length ? `${ordered.length} cells selected` : 'Select cells to set your path.'),
        React.createElement('button', { type: 'button', disabled: !ordered.length || locked,
          onClick: () => setHidden(value => !value), 'aria-pressed': hidden }, hidden ? 'Show grid' : 'Hide grid')
      )
    )
  );
};

export default App;
