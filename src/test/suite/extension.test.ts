import * as assert from 'assert';
import * as vscode from 'vscode';

suite('CodeAtlas Extension Test Suite', () => {
    vscode.window.showInformationMessage('Start all tests.');

    test('Should activate CodeAtlas extension', async () => {
        const extension = vscode.extensions.getExtension('giauphan.codeatlas-enterprise');
        assert.ok(extension);

        if (!extension.isActive) {
            await extension.activate();
        }
        assert.ok(extension.isActive);
    });

    test('Should register codeatlas.analyzeProject command', async () => {
        const commands = await vscode.commands.getCommands(true);
        assert.ok(commands.includes('codeatlas.analyzeProject'), 'codeatlas.analyzeProject command not found');
    });

    test('Should execute codeatlas.analyzeProject command successfully', async () => {
        // This test assumes a workspace is open.
        // In a real E2E setup, you might open a dummy workspace programmatically.
        const result = await vscode.commands.executeCommand('codeatlas.analyzeProject');
        // Depending on the command's return value or side effects, you might assert more here.
        // For now, just checking if it executes without throwing an error.
        assert.ok(true, 'codeatlas.analyzeProject command failed to execute');
    }).timeout(60000); // Give it more time for analysis
});
