import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  builtinToolDefinitions,
  documentToolArtifactKind,
  hasSpreadsheetInScope,
  isDocumentContentTool,
  isDocumentCreateTool,
  looksLikeSpreadsheetRequest,
  selectBuiltinTurnTools,
  spreadsheetScopePrompt,
  summarizeDocumentToolCall,
  toolActivityHistoryNote,
} from './agentTools';
import { CONDUIT_ARTIFACT_SYSTEM_APPENDIX } from './artifactPrompt';
import { documentWriteDeveloperPromptFor } from './documentTurnIntent';
import type { AssistantStreamState, ToolCallState } from './streamState';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, '__fixtures__', 'sheetToolSchemas.json'), 'utf8')) as Record<
  string,
  { description: string; input_schema: Record<string, unknown> }
>;

const SHEET_TOOLS = ['create_spreadsheet', 'append_rows', 'update_cells', 'add_sheet', 'edit_sheet', 'read_spreadsheet'];
const EDIT_SHEET_TOOLS = SHEET_TOOLS.filter((name) => name !== 'create_spreadsheet');

const settings = { memoryEnabled: false } as Parameters<typeof selectBuiltinTurnTools>[1];
const names = (prompt: string, ...rest: Parameters<typeof selectBuiltinTurnTools> extends [string, unknown, ...infer R] ? R : never) =>
  selectBuiltinTurnTools(prompt, settings, ...rest).tools.map((tool) => tool.name);
const sheetNames = (prompt: string, inScope?: boolean, intent?: 'create' | 'edit' | 'info' | 'general') =>
  selectBuiltinTurnTools(prompt, settings, null, intent, undefined, undefined, undefined, undefined, inScope).tools
    .map((tool) => tool.name)
    .filter((name) => SHEET_TOOLS.includes(name));

describe('spreadsheet tool definitions', () => {
  const sheetDefs = builtinToolDefinitions().filter((tool) => tool.displayGroup === 'Spreadsheets');

  it('covers exactly the fixture tools', () => {
    expect(sheetDefs.map((t) => t.name).sort()).toEqual(Object.keys(fixture).sort());
    expect(sheetDefs.map((t) => t.name)).toEqual(SHEET_TOOLS);
  });

  for (const name of SHEET_TOOLS) {
    it(`${name}: description and input schema equal the fixture`, () => {
      const def = sheetDefs.find((t) => t.name === name)!;
      expect(def.toolId).toBe(name);
      expect(def.description).toBe(fixture[name].description);
      expect(def.inputSchema).toEqual(fixture[name].input_schema);
    });
  }

  it('only read_spreadsheet is read-only', () => {
    for (const def of sheetDefs) {
      expect(def.permissionLevel, def.name).toBe(def.name === 'read_spreadsheet' ? 'readOnly' : 'sideEffectful');
    }
  });

  it('treats the writing tools as document content tools that produce a spreadsheet artifact', () => {
    for (const name of SHEET_TOOLS.filter((n) => n !== 'read_spreadsheet')) {
      expect(isDocumentContentTool(name), name).toBe(true);
      expect(documentToolArtifactKind(name), name).toBe('spreadsheet');
    }
    expect(isDocumentContentTool('read_spreadsheet')).toBe(false);
    expect(isDocumentCreateTool('create_spreadsheet')).toBe(true);
    expect(isDocumentCreateTool('append_rows')).toBe(false);
  });
});

describe('looksLikeSpreadsheetRequest', () => {
  it.each([
    'Make me a spreadsheet for my monthly budget',
    'create an Excel workbook that tracks my expenses',
    'I need an xlsx of the menu prices',
    'save it as menu.xlsx',
    'build a budget sheet for the move',
    'a cost model for the cafe with formulas',
    'put together a BOM for the sign',
    'a bill of materials for a 43 inch display',
    'make a loan schedule for $20,000 at 6%',
    'a sales forecast sheet by month',
    'give me a table I can calculate totals in',
    'a pivot table of sales by region',
    'build a timesheet for the team',
    'Convert this CSV into an Excel file',
    // The app's other languages.
    'Erstelle mir eine Tabelle für mein monatliches Haushaltsbudget mit Einnahmen, Ausgaben nach Kategorien und Summen.',
    'Mach eine Tabellenkalkulation für die Hochzeit',
    // A version number's "." doesn't end the sentence before "Summenzeile".
    'Erstelle eine Tabelle für das Launch-Budget von Ferry 1.0 in Euro mit einer Summenzeile.',
    'Erstelle eine Tabelle für unser Budget',
    'Crée un tableur pour mon budget',
    'Fais une feuille de calcul des dépenses',
    'Haz una hoja de cálculo con los gastos del mes',
    'Crea una tabla con los gastos y los totales',
    'Faça uma planilha de orçamento mensal',
    '月の予算のスプレッドシートを作って',
    '가계부 스프레드시트를 만들어 줘',
    '帮我做一个月度预算的电子表格',
  ])('is a spreadsheet request: %s', (prompt) => {
    expect(looksLikeSpreadsheetRequest(prompt)).toBe(true);
  });

  it.each([
    'Write me a poem',
    'Make a cheat sheet for git',
    'Draft a fact sheet about our product',
    'Add a style sheet to the page',
    'Find sheet music for Clair de Lune',
    'Write a one-page spec sheet for the router',
    'I want to excel at chess',
    'How do I excel in my first job?',
    'Make a loan calculator web app',
    'Build a landing page with a pricing table',
    'Change the bed sheet colour in the picture',
    'Erstelle eine Tabelle mit den Hauptstädten Europas',
    'Erstelle eine Tabelle der Planeten. Rechne dann im Kopf die Summen nach.',
    'Haz una tabla comparando tres teléfonos',
    'Fais un tableau des rois de France',
    '',
  ])('is not a spreadsheet request: %s', (prompt) => {
    expect(looksLikeSpreadsheetRequest(prompt)).toBe(false);
  });
});

describe('offering the spreadsheet tools', () => {
  it('offers all six on a spreadsheet request, in place of the document write and edit tools', () => {
    for (const prompt of ['Make me a spreadsheet for my budget', 'create an excel workbook for the cafe menu']) {
      const offered = names(prompt);
      expect(offered).toEqual(expect.arrayContaining(SHEET_TOOLS));
      expect(offered.filter((n) => /^(write|edit)_\w+_document$/.test(n)), prompt).toEqual([]);
      expect(offered).not.toContain('patch_document');
      expect(offered).not.toContain('write_html_document');
    }
  });

  it('does not swap the document tools on an ordinary document request', () => {
    const offered = names('Create an HTML page about otters');
    expect(offered).toContain('write_html_document');
    expect(offered.filter((n) => SHEET_TOOLS.includes(n))).toEqual([]);
  });

  it('still offers start_deck alongside when the turn also asks for slides', () => {
    const offered = names('Make a spreadsheet and a slide deck of the budget');
    expect(offered).toContain('start_deck');
    expect(offered).toContain('create_spreadsheet');
  });

  it('offers read and edit tools, not create, in a chat that has a spreadsheet', () => {
    expect(sheetNames('add a column for tax', true)).toEqual(EDIT_SHEET_TOOLS);
    expect(sheetNames('what is the grand total?', true)).toEqual(EDIT_SHEET_TOOLS);
    expect(sheetNames('añade una columna de impuestos', true, 'general')).toEqual(EDIT_SHEET_TOOLS);
    expect(sheetNames('add a column for tax', false)).toEqual([]);
    expect(sheetNames('add a column for tax')).toEqual([]);
  });

  it('does not offer them when the turn asks for a new, different document', () => {
    expect(sheetNames('Create an HTML page about otters', true)).toEqual([]);
  });

  it('offers all six on a new spreadsheet request even with one in the chat', () => {
    expect(sheetNames('make another spreadsheet for the second quarter', true)).toEqual(SHEET_TOOLS);
  });

  it('does not make the system prompts talk about HTML document tools', () => {
    const toolNames = names('Make me a spreadsheet for my budget');
    expect(documentWriteDeveloperPromptFor(toolNames)).toBeUndefined();
    expect(CONDUIT_ARTIFACT_SYSTEM_APPENDIX(toolNames)).not.toContain('write_*_document');
  });

  it('points the model at the spreadsheet tools instead of a fence', () => {
    const appendix = CONDUIT_ARTIFACT_SYSTEM_APPENDIX(names('Make me a spreadsheet for my budget'));
    expect(appendix).toContain('create_spreadsheet');
    expect(appendix).not.toContain('No document tools are available');
  });
});

describe('spreadsheet scope', () => {
  const sheet = { id: 's1', kind: 'spreadsheet' as const, title: 'Menu board' };
  const page = { id: 'h1', kind: 'html' as const, title: 'Page' };

  it('detects a spreadsheet listed for the chat or open in the panel', () => {
    expect(hasSpreadsheetInScope([page, sheet])).toBe(true);
    expect(hasSpreadsheetInScope([page], sheet)).toBe(true);
    expect(hasSpreadsheetInScope([page], page)).toBe(false);
    expect(hasSpreadsheetInScope([])).toBe(false);
  });

  it('names the spreadsheets and their ids for the model, the open one first', () => {
    const other = { id: 's2', kind: 'spreadsheet' as const, title: 'Loan' };
    const text = spreadsheetScopePrompt([page, sheet, other], other)!;
    expect(text.indexOf('s2')).toBeLessThan(text.indexOf('s1'));
    expect(text).toContain('"Menu board" (artifact_id s1)');
    expect(text).not.toContain('h1');
    expect(spreadsheetScopePrompt([page])).toBeUndefined();
  });
});

describe('spreadsheet calls in the turn history and activity', () => {
  function call(name: string, args: Record<string, unknown>, id = name): ToolCallState {
    return { toolCallId: id, name, arguments: args, complete: true, status: 'completed' } as unknown as ToolCallState;
  }
  const stateOf = (...calls: ToolCallState[]) => ({ toolCalls: calls }) as unknown as AssistantStreamState;

  it('records a created spreadsheet with its artifact id', () => {
    const note = toolActivityHistoryNote(stateOf(call('create_spreadsheet', { title: 'Menu board', sheets: [] })), {
      turnId: 'm1',
      artifacts: [
        { id: 's1', kind: 'spreadsheet', title: 'Menu board', sourceMessageId: 'm1', createdAt: '2026-11-02T00:00:00Z' },
      ],
    });
    expect(note).toBe('create_spreadsheet: created spreadsheet "Menu board" (artifact_id s1)');
  });

  it('records edits and reads against the spreadsheet', () => {
    const artifacts = [
      {
        id: 's1',
        kind: 'spreadsheet' as const,
        title: 'Menu board',
        sourceMessageId: 'm1',
        createdAt: '2026-11-02T00:00:00Z',
      },
    ];
    const note = toolActivityHistoryNote(
      stateOf(call('update_cells', { artifact_id: 's1', sheet: 'A', start: 'A1', rows: [[1]] }), call('read_spreadsheet', { artifact_id: 's1' })),
      { turnId: 'm2', artifacts },
    );
    expect(note).toBe(
      'update_cells: changed spreadsheet "Menu board" (artifact_id s1); read_spreadsheet: read spreadsheet "Menu board" (artifact_id s1)',
    );
  });

  it('summarises a spreadsheet call for the tool card', () => {
    const summary = summarizeDocumentToolCall(call('create_spreadsheet', { title: 'Menu board', sheets: [] }));
    expect(summary).toMatchObject({ action: 'create', kind: 'spreadsheet', title: 'Menu board' });
    expect(summarizeDocumentToolCall(call('edit_sheet', { artifact_id: 's1', sheet: 'A' }))).toMatchObject({
      action: 'edit',
      kind: 'spreadsheet',
    });
  });
});
