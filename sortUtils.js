export function compareCellIds(idA, idB) {
  const colA = idA.charAt(0);
  const rowA = parseInt(idA.substring(1), 10);
  const colB = idB.charAt(0);
  const rowB = parseInt(idB.substring(1), 10);

  if (colA < colB) return -1;
  if (colA > colB) return 1;
  
  // Columns are the same, compare rows
  if (rowA < rowB) return -1;
  if (rowA > rowB) return 1;
  
  return 0;
}