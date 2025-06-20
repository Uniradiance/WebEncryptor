export const ROWS = 6;
export const COLS = 6;
export const COL_LABELS = ['A', 'B', 'C', 'D', 'E', 'F'];
export const ROW_LABELS = ['0', '1', '2', '3', '4', '5'];

export const COLOR_SEQUENCE = [
  null, 
  'RED',
  'GREEN',
  'BLUE',
  'BLACK',
];

// Changed from COLOR_TO_CLASS_MAP to COLOR_TO_STYLE_MAP
export const COLOR_TO_STYLE_MAP = {
  'RED': { backgroundColor: '#FF6666', color: 'white' }, // bg-red-500 text-white
  'GREEN': { backgroundColor: '#66C55E', color: 'white' }, // bg-green-500 text-white
  'BLUE': { backgroundColor: '#2288FF', color: 'white' }, // bg-blue-500 text-white
  'BLACK': { backgroundColor: '#223243', color: 'white' }, // bg-black text-white
};

// Changed from DEFAULT_CELL_BG (string) to DEFAULT_CELL_STYLE (object)
// hover:bg-gray-400 is removed as it's not directly translatable to inline styles without JS event handlers
export const DEFAULT_CELL_STYLE = { backgroundColor: '#CAD1DA' }; // bg-gray-300

// Storing the border color value directly for use in inline styles
export const BORDER_COLOR_VALUE = '#6B7280'; // border-gray-500
