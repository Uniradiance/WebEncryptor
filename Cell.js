import React from 'react';
import { COLOR_TO_STYLE_MAP, DEFAULT_CELL_STYLE, BORDER_COLOR_VALUE } from './constants.js';
// Removed: import { CellData } from '../types';

// Removed CellProps interface

const Cell = ({ cellData, onInteractionStart, onPointerEnter }) => {
  const cellStyleFromMap = cellData.color ? COLOR_TO_STYLE_MAP[cellData.color] : DEFAULT_CELL_STYLE;

  const handleMouseDown = (event) => {
    onInteractionStart(cellData.row, cellData.col, 'mouse');
  };

  const handleTouchStart = (event) => {
    // Prevent default to avoid synthetic mouse events and scrolling on touch devices.
    event.preventDefault();
    event.stopPropagation(); 
    onInteractionStart(cellData.row, cellData.col, 'touch');
  };

  const handleMouseEnter = () => {
    onPointerEnter(cellData.row, cellData.col, cellData.id);
  };

  const combinedStyle = {
    width: '4rem', 
    height: '4rem', 
    border: `1px solid ${BORDER_COLOR_VALUE}`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    userSelect: 'none', 
    touchAction: 'none', 
    transition: 'background-color 0.15s', 
    ...cellStyleFromMap, 
  };

  return (
    React.createElement('div', {
      style: combinedStyle,
      onMouseDown: handleMouseDown,
      onMouseEnter: handleMouseEnter,
      onTouchStart: handleTouchStart,
      'data-row': cellData.row,
      'data-col': cellData.col,
      'data-cell': "true",
      role: "gridcell",
      'aria-label': `Cell ${cellData.id}, Color: ${cellData.color || 'None'}`,
      id: cellData.id
    }, null /* No children for this div */
    )
  );
};

export default Cell;