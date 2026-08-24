const fs = require('fs');
let code = fs.readFileSync('dashboard/src/components/DreamMemoryView.tsx', 'utf8');

code = code.replace('layout="true"', 'layout');
fs.writeFileSync('dashboard/src/components/DreamMemoryView.tsx', code);
