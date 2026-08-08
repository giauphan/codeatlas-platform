const fs = require('fs');

function applyAriaLabels(filePath) {
    let content = fs.readFileSync(filePath, 'utf8');
    let changed = false;

    // KnowledgeGraphView - fullscreen toggle
    if (filePath.includes('KnowledgeGraphView.tsx')) {
        // It already has aria-label={isFullscreen ? ...}, we only need to fix the delete button if missing
        if (content.includes('Delete Project Index') && !content.includes('aria-label="Delete project"')) {
            content = content.replace(
                /(\s*<button\s*\n\s*onClick=\{\(\) => \{[\s\S]*?\}\}\s*\n\s*style=\{\{)/,
                '$1\n            aria-label="Delete project"'
            );
            changed = true;
        }
    }

    if (filePath.includes('OrchestrationTasksView.tsx')) {
        if (content.includes('Refresh Tasks') && !content.includes('aria-label="Refresh tasks"')) {
             content = content.replace(
                /(<motion.button\s*\n\s*whileHover[\s\S]*?\n\s*onClick=\{fetchTasks\}[\s\S]*?\n\s*disabled=\{loading\})/,
                '$1\n          aria-label="Refresh tasks"'
            );
            changed = true;
        }
    }

    if (filePath.includes('DreamMemoryView.tsx')) {
        if (content.includes('Config') && !content.includes('aria-label="Toggle configuration"')) {
             content = content.replace(
                /(<button onClick=\{\(\) => \{\n\s*const currentConfig = dreamConfigRef.current;)/,
                '<button aria-label="Toggle configuration" onClick={() => {\n            const currentConfig = dreamConfigRef.current;'
            );
            changed = true;
        }

        if (content.includes('Clear') && !content.includes('aria-label="Clear date filters"')) {
            content = content.replace(
                /(<button\s*\n\s*onClick=\{\(\) => \{\n\s*setStartDate\(''\);\n\s*setEndDate\(''\);\n\s*setPage\(0\);\n\s*\}\}\n\s*style=\{\{)/,
                '<button\n              aria-label="Clear date filters"\n              onClick={() => {\n                setStartDate(\'\');\n                setEndDate(\'\');\n                setPage(0);\n              }}\n              style={{'
            );
            changed = true;
        }
    }

    if (changed) {
        fs.writeFileSync(filePath, content, 'utf8');
        console.log(`Updated ${filePath}`);
    }
}

['dashboard/src/components/KnowledgeGraphView.tsx', 'dashboard/src/components/OrchestrationTasksView.tsx', 'dashboard/src/components/DreamMemoryView.tsx'].forEach(applyAriaLabels);
