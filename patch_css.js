const fs = require('fs');
const cssPath = 'dashboard/src/index.css';
let css = fs.readFileSync(cssPath, 'utf8');

if (!css.includes('.clear-search-button')) {
  css += `
.clear-search-button {
  position: absolute;
  right: 12px;
  top: 50%;
  transform: translateY(-50%);
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
`;
}
fs.writeFileSync(cssPath, css);
