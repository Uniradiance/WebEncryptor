import React from 'react';
import { COLOR_TO_STYLE_MAP, DEFAULT_CELL_STYLE, BORDER_COLOR_VALUE } from './constants.js';
// Removed: import { CellData } from '../types';

// Removed CellProps interface

const Cell = ({ cellData, onInteractionStart, onPointerEnter, hidden = false, disabled = false, order }) => {
  const cellStyleFromMap = !hidden && cellData.color ? COLOR_TO_STYLE_MAP[cellData.color] : DEFAULT_CELL_STYLE;

  const handleMouseDown = (event) => {
    if (disabled) return;
    onInteractionStart(cellData.row, cellData.col, 'mouse');
  };

  const handleTouchStart = (event) => {
    // Prevent default to avoid synthetic mouse events and scrolling on touch devices.
    event.preventDefault();
    event.stopPropagation(); 
    if (disabled) return;
    onInteractionStart(cellData.row, cellData.col, 'touch');
  };

  const handleMouseEnter = () => {
    if (disabled) return;
    onPointerEnter(cellData.row, cellData.col, cellData.id);
  };

  const combinedStyle = {
    width: '100%', // Fill grid cell area
    height: '100%', // Fill grid cell area
    // aspectRatio: '1 / 1', // Ensure cell itself is square if parent grid cell isn't perfectly square
    border: `1px solid ${BORDER_COLOR_VALUE}`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    userSelect: 'none', 
    touchAction: 'none', 
    transition: 'background-color 0.15s', 
    boxSizing: 'border-box', // Include border and padding in the element's total width and height
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
      'aria-label': hidden ? `Cell ${cellData.id}, hidden` : `Cell ${cellData.id}, Color: ${cellData.color || 'None'}, Order: ${order || 'none'}`,
      'aria-disabled': disabled,
      id: cellData.id
    }, hidden ? '•' : (order || '')
    )
  );
};

export default Cell;