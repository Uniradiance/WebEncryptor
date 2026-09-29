import { ROWS, COLS, COL_LABELS, ROW_LABELS } from './constants.js';

export function initialGrid() {
  return {
    cells: Array.from({ length: ROWS }, (_, row) =>
      Array.from({ length: COLS }, (_, col) => ({
        id: `${COL_LABELS[col]}${ROW_LABELS[row]}`, row, col, color: null,
      }))),
    history: [], order: 0,
  };
}

export function gridReducer(state, action) {
  if (action.type === 'reset') return initialGrid();
  if (action.type === 'undo') {
    const previous = state.history.at(-1);
    return previous ? { ...previous, history: state.history.slice(0, -1) } : state;
  }
  if (action.type !== 'paint') return state;
  const { row, col, color } = action;
  const before = state.cells[row][col];
  if (before.color === color) return state;
  const cells = state.cells.slice();
  cells[row] = cells[row].slice();
  const cell = { ...before, color };
  if (color === null) delete cell.lastSetTimestamp;
  else cell.lastSetTimestamp = state.order + 1;
  cells[row][col] = cell;
  return { cells, order: state.order + 1, history: [...state.history.slice(-255), { cells: state.cells, order: state.order }] };
}

export function orderedCells(cells) {
  return cells.flat().filter(cell => cell.color !== null)
    .sort((a, b) => a.lastSetTimestamp - b.lastSetTimestamp);
}

export function gridPath(cells) {
  return orderedCells(cells).map(cell => `${cell.color}${cell.id}`).join('');
}
