/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import 'mocha';
import { TextDecoder } from 'util';
import * as vscode from 'vscode';
import { asPromise, assertNoRpc, closeAllEditors, createRandomFile, disposeAll, revertAllDirty, saveAllEditors } from '../utils';

async function createRandomNotebookFile() {
	return createRandomFile('', undefined, '.vsctestnb');
}

async function openRandomNotebookDocument() {
	const uri = await createRandomNotebookFile();
	return vscode.workspace.openNotebookDocument(uri);
}

export async function saveAllFilesAndCloseAll() {
	await saveAllEditors();
	await closeAllEditors();
}

async function withEvent<T>(event: vscode.Event<T>, callback: (e: Promise<T>) => Promise<void>) {
	const e = asPromise<T>(event);
	await callback(e);
}


function sleep(ms: number): Promise<void> {
	return new Promise(resolve => {
		setTimeout(resolve, ms);
	});
}

export class Kernel {

	readonly controller: vscode.NotebookController;

	readonly associatedNotebooks = new Set<string>();

	constructor(id: string, label: string, viewType: string = 'notebookCoreTest') {
		this.controller = vscode.notebooks.createNotebookController(id, viewType, label);
		this.controller.executeHandler = this._execute.bind(this);
		this.controller.supportsExecutionOrder = true;
		this.controller.supportedLanguages = ['typescript', 'javascript'];
		this.controller.onDidChangeSelectedNotebooks(e => {
			if (e.selected) {
				this.associatedNotebooks.add(e.notebook.uri.toString());
			} else {
				this.associatedNotebooks.delete(e.notebook.uri.toString());
			}
		});
	}

	protected async _execute(cells: vscode.NotebookCell[]): Promise<void> {
		for (const cell of cells) {
			await this._runCell(cell);
		}
	}

	protected async _runCell(cell: vscode.NotebookCell) {
		// create a single output with exec order 1 and output is plain/text
		// of either the cell itself or (iff empty) the cell's document's uri
		const task = this.controller.createNotebookCellExecution(cell);
		task.start(Date.now());
		task.executionOrder = 1;
		await sleep(10); // Force to be take some time
		await task.replaceOutput([new vscode.NotebookCellOutput([
			vscode.NotebookCellOutputItem.text(cell.document.getText() || cell.document.uri.toString(), 'text/plain')
		])]);
		task.end(true);
	}
}


async function assertKernel(kernel: Kernel, notebook: vscode.NotebookDocument): Promise<void> {
	const success = await vscode.commands.executeCommand('notebook.selectKernel', {
		extension: 'vscode.vscode-api-tests',
		id: kernel.controller.id
	});
	assert.ok(success, `expected selected kernel to be ${kernel.controller.id}`);
	assert.ok(kernel.associatedNotebooks.has(notebook.uri.toString()));
}

const apiTestContentProvider: vscode.NotebookContentProvider = {
	openNotebook: async (resource: vscode.Uri): Promise<vscode.NotebookData> => {
		if (/.*empty\-.*\.vsctestnb$/.test(resource.path)) {
			return {
				metadata: {},
				cells: []
			};
		}

		const dto: vscode.NotebookData = {
			metadata: { custom: { testMetadata: false } },
			cells: [
				{
					value: 'test',
					languageId: 'typescript',
					kind: vscode.NotebookCellKind.Code,
					outputs: [],
					metadata: { custom: { testCellMetadata: 123 } },
					executionSummary: { timing: { startTime: 10, endTime: 20 } }
				},
				{
					value: 'test2',
					languageId: 'typescript',
					kind: vscode.NotebookCellKind.Code,
					outputs: [
						new vscode.NotebookCellOutput([
							vscode.NotebookCellOutputItem.text('Hello World', 'text/plain')
						],
							{
								testOutputMetadata: true,
								['text/plain']: { testOutputItemMetadata: true }
							})
					],
					executionSummary: { executionOrder: 5, success: true },
					metadata: { custom: { testCellMetadata: 456 } }
				}
			]
		};
		return dto;
	},
	saveNotebook: async (_document: vscode.NotebookDocument, _cancellation: vscode.CancellationToken) => {
		return;
	},
	saveNotebookAs: async (_targetResource: vscode.Uri, _document: vscode.NotebookDocument, _cancellation: vscode.CancellationToken) => {
		return;
	},
	backupNotebook: async (_document: vscode.NotebookDocument, _context: vscode.NotebookDocumentBackupContext, _cancellation: vscode.CancellationToken) => {
		return {
			id: '1',
			delete: () => { }
		};
	}
};

(vscode.env.uiKind === vscode.UIKind.Web ? suite.skip : suite)('Notebook Kernel API tests', function () {

	const testDisposables: vscode.Disposable[] = [];
	const suiteDisposables: vscode.Disposable[] = [];

	suiteTeardown(async function () {

		assertNoRpc();

		await revertAllDirty();
		await closeAllEditors();

		disposeAll(suiteDisposables);
		suiteDisposables.length = 0;
	});

	suiteSetup(function () {
		suiteDisposables.push(vscode.workspace.registerNotebookContentProvider('notebookCoreTest', apiTestContentProvider));
	});

	let defaultKernel: Kernel;

	setup(async function () {
		// there should be ONE default kernel in this suite
		defaultKernel = new Kernel('mainKernel', 'Notebook Default Kernel');
		testDisposables.push(defaultKernel.controller);
		await saveAllFilesAndCloseAll();
	});

	teardown(async function () {
		disposeAll(testDisposables);
		testDisposables.length = 0;
		await saveAllFilesAndCloseAll();
	});

	// TODO@rebornix this is wrong, `await vscode.commands.executeCommand('notebook.execute');` doesn't wait until the workspace edit is applied
	test.skip('cell execute command takes arguments', async () => {
		const notebook = await openRandomNotebookDocument();
		await vscode.window.showNotebookDocument(notebook);
		assert.strictEqual(vscode.window.activeNotebookEditor !== undefined, true, 'notebook first');
		const editor = vscode.window.activeNotebookEditor!;
		const cell = editor.notebook.cellAt(0);

		await vscode.commands.executeCommand('notebook.execute');
		assert.strictEqual(cell.outputs.length, 0, 'should not execute'); // not runnable, didn't work
	});

	test('cell execute command takes arguments 2', async () => {
		const notebook = await openRandomNotebookDocument();
		await vscode.window.showNotebookDocument(notebook);
		assert.strictEqual(vscode.window.activeNotebookEditor !== undefined, true, 'notebook first');
		const editor = vscode.window.activeNotebookEditor!;
		const cell = editor.notebook.cellAt(0);

		await withEvent(vscode.workspace.onDidChangeNotebookDocument, async (event) => {
			await vscode.commands.executeCommand('notebook.execute');
			await event;
			assert.strictEqual(cell.outputs.length, 1, 'should execute'); // runnable, it worked
		});

		await withEvent(vscode.workspace.onDidChangeNotebookDocument, async event => {
			await vscode.commands.executeCommand('notebook.cell.clearOutputs');
			await event;
			assert.strictEqual(cell.outputs.length, 0, 'should clear');
		});

		const secondResource = await createRandomNotebookFile();
		await vscode.commands.executeCommand('vscode.openWith', secondResource, 'notebookCoreTest');

		await withEvent<vscode.NotebookDocumentChangeEvent>(vscode.workspace.onDidChangeNotebookDocument, async (event) => {
			await vscode.commands.executeCommand('notebook.cell.execute', { start: 0, end: 1 }, notebook.uri);
			await event;
			assert.strictEqual(cell.outputs.length, 1, 'should execute'); // runnable, it worked
			assert.strictEqual(vscode.window.activeNotebookEditor?.notebook.uri.fsPath, secondResource.fsPath);
		});
	});

	// #126371
	test.skip('cell execute command takes arguments ICellRange[]', async () => {
		const notebook = await openRandomNotebookDocument();
		await vscode.window.showNotebookDocument(notebook);

		vscode.commands.executeCommand('notebook.cell.execute', { ranges: [{ start: 0, end: 1 }, { start: 1, end: 2 }] });
		let firstCellExecuted = false;
		let secondCellExecuted = false;
		let resolve: () => void;
		const p = new Promise<void>(r => resolve = r);
		const listener = vscode.workspace.onDidChangeNotebookDocument(e => {
			e.cellChanges.forEach(change => {
				if (change.cell.index === 0) {
					firstCellExecuted = true;
				}

				if (change.cell.index === 1) {
					secondCellExecuted = true;
				}
			});

			if (firstCellExecuted && secondCellExecuted) {
				resolve();
			}
		});

		await p;
		listener.dispose();
		await saveAllFilesAndCloseAll();
	});

	test('document execute command takes arguments', async () => {
		const notebook = await openRandomNotebookDocument();
		await vscode.window.showNotebookDocument(notebook);
		assert.strictEqual(vscode.window.activeNotebookEditor !== undefined, true, 'notebook first');
		const editor = vscode.window.activeNotebookEditor!;
		const cell = editor.notebook.cellAt(0);

		await withEvent<vscode.NotebookDocumentChangeEvent>(vscode.workspace.onDidChangeNotebookDocument, async (event) => {
			await vscode.commands.executeCommand('notebook.execute', notebook.uri);
			await event;
			assert.strictEqual(cell.outputs.length, 1, 'should execute'); // runnable, it worked
		});
	});

	test('cell execute and select kernel', async function () {
		const notebook = await openRandomNotebookDocument();
		const editor = await vscode.window.showNotebookDocument(notebook);
		assert.strictEqual(vscode.window.activeNotebookEditor === editor, true, 'notebook first');

		const cell = editor.notebook.cellAt(0);

		const alternativeKernel = new class extends Kernel {
			constructor() {
				super('secondaryKernel', 'Notebook Secondary Test Kernel');
				this.controller.supportsExecutionOrder = false;
			}

			override async _runCell(cell: vscode.NotebookCell) {
				const task = this.controller.createNotebookCellExecution(cell);
				task.start();
				await task.replaceOutput([new vscode.NotebookCellOutput([
					vscode.NotebookCellOutputItem.text('my second output', 'text/plain')
				])]);
				task.end(true);
			}
		};
		testDisposables.push(alternativeKernel.controller);

		await withEvent<vscode.NotebookDocumentChangeEvent>(vscode.workspace.onDidChangeNotebookDocument, async (event) => {
			await assertKernel(defaultKernel, notebook);
			await vscode.commands.executeCommand('notebook.cell.execute');
			await event;
			assert.strictEqual(cell.outputs.length, 1, 'should execute'); // runnable, it worked
			assert.strictEqual(cell.outputs[0].items.length, 1);
			assert.strictEqual(cell.outputs[0].items[0].mime, 'text/plain');
			assert.deepStrictEqual(new TextDecoder().decode(cell.outputs[0].items[0].data), cell.document.getText());
		});

		await withEvent<vscode.NotebookDocumentChangeEvent>(vscode.workspace.onDidChangeNotebookDocument, async (event) => {
			await assertKernel(alternativeKernel, notebook);
			await vscode.commands.executeCommand('notebook.cell.execute');
			await event;
			assert.strictEqual(cell.outputs.length, 1, 'should execute'); // runnable, it worked
			assert.strictEqual(cell.outputs[0].items.length, 1);
			assert.strictEqual(cell.outputs[0].items[0].mime, 'text/plain');
			assert.deepStrictEqual(new TextDecoder().decode(cell.outputs[0].items[0].data), 'my second output');
		});
	});

	test.skip('onDidChangeCellExecutionState is fired', async () => { // TODO@rebornix https://github.com/microsoft/vscode/issues/139350
		const notebook = await openRandomNotebookDocument();
		const editor = await vscode.window.showNotebookDocument(notebook);
		const cell = editor.notebook.cellAt(0);

		vscode.commands.executeCommand('notebook.cell.execute');
		let eventCount = 0;
		let resolve: () => void;
		const p = new Promise<void>(r => resolve = r);
		const listener = vscode.notebooks.onDidChangeNotebookCellExecutionState(e => {
			if (eventCount === 0) {
				assert.strictEqual(e.state, vscode.NotebookCellExecutionState.Pending, 'should be set to Pending');
			} else if (eventCount === 1) {
				assert.strictEqual(e.state, vscode.NotebookCellExecutionState.Executing, 'should be set to Executing');
				assert.strictEqual(cell.outputs.length, 0, 'no outputs yet: ' + JSON.stringify(cell.outputs[0]));
			} else if (eventCount === 2) {
				assert.strictEqual(e.state, vscode.NotebookCellExecutionState.Idle, 'should be set to Idle');
				assert.strictEqual(cell.outputs.length, 1, 'should have an output');
				resolve();
			}

			eventCount++;
		});

		await p;
		listener.dispose();
	});

	test('Output changes are applied once the promise resolves', async function () {

		let called = false;

		const verifyOutputSyncKernel = new class extends Kernel {

			constructor() {
				super('verifyOutputSyncKernel', '');
			}

			override async _execute(cells: vscode.NotebookCell[]) {
				const [cell] = cells;
				const task = this.controller.createNotebookCellExecution(cell);
				task.start();
				await task.replaceOutput([new vscode.NotebookCellOutput([
					vscode.NotebookCellOutputItem.text('Some output', 'text/plain')
				])]);
				assert.strictEqual(cell.notebook.cellAt(0).outputs.length, 1);
				assert.deepStrictEqual(new TextDecoder().decode(cell.notebook.cellAt(0).outputs[0].items[0].data), 'Some output');
				task.end(undefined);
				called = true;
			}
		};

		const notebook = await openRandomNotebookDocument();
		await vscode.window.showNotebookDocument(notebook);
		await assertKernel(verifyOutputSyncKernel, notebook);
		await vscode.commands.executeCommand('notebook.cell.execute');
		assert.strictEqual(called, true);
		verifyOutputSyncKernel.controller.dispose();
	});

	test('executionSummary', async () => {
		const notebook = await openRandomNotebookDocument();
		const editor = await vscode.window.showNotebookDocument(notebook);
		const cell = editor.notebook.cellAt(0);

		assert.strictEqual(cell.executionSummary?.success, undefined);
		assert.strictEqual(cell.executionSummary?.executionOrder, undefined);
		await vscode.commands.executeCommand('notebook.cell.execute');
		assert.strictEqual(cell.outputs.length, 1, 'should execute');
		assert.ok(cell.executionSummary);
		assert.strictEqual(cell.executionSummary!.success, true);
		assert.strictEqual(typeof cell.executionSummary!.executionOrder, 'number');
	});

	test('initialize executionSummary', async () => {

		const document = await openRandomNotebookDocument();
		const cell = document.cellAt(0);

		assert.strictEqual(cell.executionSummary?.success, undefined);
		assert.strictEqual(cell.executionSummary?.timing?.startTime, 10);
		assert.strictEqual(cell.executionSummary?.timing?.endTime, 20);

	});

	test('execution cancelled when delete while executing', async () => {
		const document = await openRandomNotebookDocument();
		const cell = document.cellAt(0);

		let executionWasCancelled = false;
		const cancelledKernel = new class extends Kernel {
			constructor() {
				super('cancelledKernel', '');
			}

			override async _execute(cells: vscode.NotebookCell[]) {
				const [cell] = cells;
				const exe = this.controller.createNotebookCellExecution(cell);
				exe.token.onCancellationRequested(() => executionWasCancelled = true);
			}
		};
		testDisposables.push(cancelledKernel.controller);

		await vscode.window.showNotebookDocument(document);
		await assertKernel(cancelledKernel, document);
		await vscode.commands.executeCommand('notebook.cell.execute');

		// Delete executing cell
		const edit = new vscode.WorkspaceEdit();
		edit.replaceNotebookCells(cell!.notebook.uri, new vscode.NotebookRange(cell!.index, cell!.index + 1), []);
		await vscode.workspace.applyEdit(edit);

		assert.strictEqual(executionWasCancelled, true);
	});

	test('appendOutput to different cell', async function () {
		const notebook = await openRandomNotebookDocument();
		const editor = await vscode.window.showNotebookDocument(notebook);
		const cell0 = editor.notebook.cellAt(0);
		const notebookEdit = new vscode.NotebookEdit(new vscode.NotebookRange(1, 1), [new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'test 2', 'javascript')]);
		const edit = new vscode.WorkspaceEdit();
		edit.set(notebook.uri, [notebookEdit]);
		await vscode.workspace.applyEdit(edit);
		const cell1 = editor.notebook.cellAt(1);

		const nextCellKernel = new class extends Kernel {
			constructor() {
				super('nextCellKernel', 'Append to cell kernel');
			}

			override async _runCell(cell: vscode.NotebookCell) {
				const task = this.controller.createNotebookCellExecution(cell);
				task.start();
				await task.appendOutput([new vscode.NotebookCellOutput([
					vscode.NotebookCellOutputItem.text('my output')
				])], cell1);
				await task.appendOutput([new vscode.NotebookCellOutput([
					vscode.NotebookCellOutputItem.text('my output 2')
				])], cell1);
				task.end(true);
			}
		};
		testDisposables.push(nextCellKernel.controller);

		await withEvent<vscode.NotebookDocumentChangeEvent>(vscode.workspace.onDidChangeNotebookDocument, async (event) => {
			await assertKernel(nextCellKernel, notebook);
			await vscode.commands.executeCommand('notebook.cell.execute');
			await event;
			assert.strictEqual(cell0.outputs.length, 0, 'should not change cell 0');
			assert.strictEqual(cell1.outputs.length, 2, 'should update cell 1');
			assert.strictEqual(cell1.outputs[0].items.length, 1);
			assert.deepStrictEqual(new TextDecoder().decode(cell1.outputs[0].items[0].data), 'my output');
		});
	});

	test('replaceOutput to different cell', async function () {
		const notebook = await openRandomNotebookDocument();
		const editor = await vscode.window.showNotebookDocument(notebook);
		const cell0 = editor.notebook.cellAt(0);
		const notebookEdit = new vscode.NotebookEdit(new vscode.NotebookRange(1, 1), [new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'test 2', 'javascript')]);
		const edit = new vscode.WorkspaceEdit();
		edit.set(notebook.uri, [notebookEdit]);
		await vscode.workspace.applyEdit(edit);
		const cell1 = editor.notebook.cellAt(1);

		const nextCellKernel = new class extends Kernel {
			constructor() {
				super('nextCellKernel', 'Replace to cell kernel');
			}

			override async _runCell(cell: vscode.NotebookCell) {
				const task = this.controller.createNotebookCellExecution(cell);
				task.start();
				await task.replaceOutput([new vscode.NotebookCellOutput([
					vscode.NotebookCellOutputItem.text('my output')
				])], cell1);
				await task.replaceOutput([new vscode.NotebookCellOutput([
					vscode.NotebookCellOutputItem.text('my output 2')
				])], cell1);
				task.end(true);
			}
		};
		testDisposables.push(nextCellKernel.controller);

		await withEvent<vscode.NotebookDocumentChangeEvent>(vscode.workspace.onDidChangeNotebookDocument, async (event) => {
			await assertKernel(nextCellKernel, notebook);
			await vscode.commands.executeCommand('notebook.cell.execute');
			await event;
			assert.strictEqual(cell0.outputs.length, 0, 'should not change cell 0');
			assert.strictEqual(cell1.outputs.length, 1, 'should update cell 1');
			assert.strictEqual(cell1.outputs[0].items.length, 1);
			assert.deepStrictEqual(new TextDecoder().decode(cell1.outputs[0].items[0].data), 'my output 2');
		});
	});
});
