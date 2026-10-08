/// Ready-made workflows to start from. Each is a complete, valid definition
/// (the backend validates it again on save); the user changes the inputs when
/// running it, or the steps in the editor.
///
/// Prompts sent to the model stay in English: they are instructions to the
/// model, not interface text, and every supported model follows English
/// instructions best.

import type { WorkflowDefinition } from '../ipc/contracts';

export interface StarterWorkflow {
  id: string;
  /** i18n key for the name. */
  nameKey: string;
  /** i18n key for the one-line description. */
  blurbKey: string;
  definition: WorkflowDefinition;
}

export const STARTER_WORKFLOWS: readonly StarterWorkflow[] = [
  {
    id: 'briefing',
    nameKey: 'workspace.workflows.starter.briefing.name',
    blurbKey: 'workspace.workflows.starter.briefing.blurb',
    definition: {
      inputs: [
        { id: 'site_one', label: 'First site', default: 'https://news.ycombinator.com' },
        { id: 'site_two', label: 'Second site', default: 'https://www.theverge.com' },
      ],
      steps: [
        { id: 'fetch', type: 'fetch_page', urls: ['{{inputs.site_one}}', '{{inputs.site_two}}'] },
        {
          id: 'each_site',
          type: 'for_each',
          items: 'steps.fetch.pages',
          steps: [
            // Names the site first, so every section says where it came from.
            // `error` is empty unless the page could not be fetched, so a dead
            // site shows as a heading and a short line instead of vanishing.
            // One newline, not a blank line, so the summary (or nothing, when
            // the summary is skipped for a dead site) follows without a gap.
            {
              id: 'heading',
              type: 'template',
              template: '## {{item.url}}\n{{item.error}}',
            },
            {
              id: 'summary',
              type: 'summarize',
              prompt: 'List the three most important stories on this page, one line each.',
              // Blank for a page that could not be fetched: the step then refuses (and
              // is skipped) without calling the model.
              input: '{{item.title}}\n\n{{item.text}}',
              onError: 'skip',
            },
          ],
        },
        {
          id: 'briefing',
          type: 'template',
          template:
            '# Briefing for {{run.date}}\n\n{{#each steps.each_site.items}}{{item.heading.text}}{{item.summary.text}}\n\n{{/each}}',
        },
        { id: 'save', type: 'save_artifact', title: 'Morning briefing', content: '{{steps.briefing.text}}' },
      ],
    },
  },
  {
    id: 'page-summary',
    nameKey: 'workspace.workflows.starter.pageSummary.name',
    blurbKey: 'workspace.workflows.starter.pageSummary.blurb',
    definition: {
      inputs: [{ id: 'url', label: 'Page', default: 'https://en.wikipedia.org/wiki/Special:Random' }],
      steps: [
        { id: 'fetch', type: 'fetch_page', urls: ['{{inputs.url}}'] },
        {
          id: 'summary',
          type: 'summarize',
          prompt: 'Summarize this page in five bullet points, then one sentence on why it matters.',
          input: '{{steps.fetch.text}}',
        },
        {
          id: 'save',
          type: 'save_artifact',
          title: 'Page summary',
          content: '{{steps.summary.text}}\n\nSource: {{inputs.url}}',
          mode: 'create',
        },
      ],
    },
  },
  {
    id: 'watch-page',
    nameKey: 'workspace.workflows.starter.watchPage.name',
    blurbKey: 'workspace.workflows.starter.watchPage.blurb',
    definition: {
      inputs: [{ id: 'url', label: 'Page', default: 'https://news.ycombinator.com' }],
      steps: [
        { id: 'fetch', type: 'fetch_page', urls: ['{{inputs.url}}'] },
        // Compares the fetched text (deterministic), not a model summary, which differs every run.
        { id: 'check', type: 'condition', value: '{{steps.fetch.text}}', is: 'changed' },
        {
          id: 'summary',
          type: 'summarize',
          prompt: "What's on this page now, and what likely changed",
          input: '{{steps.fetch.text}}',
        },
        {
          id: 'save',
          type: 'save_artifact',
          title: 'Page watch',
          content: '{{steps.summary.text}}\n\nSource: {{inputs.url}}',
          mode: 'update',
        },
        { id: 'notify', type: 'notify', title: 'This page changed', body: '{{inputs.url}}' },
      ],
    },
  },
  {
    id: 'topic-watch',
    nameKey: 'workspace.workflows.starter.topicWatch.name',
    blurbKey: 'workspace.workflows.starter.topicWatch.blurb',
    definition: {
      inputs: [{ id: 'topic', label: 'Topic', default: 'local-first software' }],
      steps: [
        { id: 'search', type: 'web_search', query: '{{inputs.topic}} news', maxResults: 5 },
        {
          id: 'digest',
          type: 'summarize',
          prompt: 'Write a short digest of what is new about "{{inputs.topic}}" from these search results.',
          input: '{{steps.search.results}}',
        },
        { id: 'save', type: 'save_artifact', title: 'Topic watch', content: '{{steps.digest.text}}' },
      ],
    },
  },
  {
    id: 'weekly-numbers-deck',
    nameKey: 'workspace.workflows.starter.weeklyDeck.name',
    blurbKey: 'workspace.workflows.starter.weeklyDeck.blurb',
    definition: {
      inputs: [{ id: 'url', label: 'Numbers (CSV address)', default: 'https://example.com/weekly-numbers.csv' }],
      steps: [
        { id: 'fetch', type: 'fetch_page', urls: ['{{inputs.url}}'] },
        { id: 'data', type: 'parse_data', input: '{{steps.fetch.pages.0.text}}', format: 'csv' },
        {
          id: 'deck',
          type: 'edit_deck',
          // Picked in the editor: a starter cannot know which deck is yours.
          deck: '',
          instructions:
            'Update the chart and the numbers on the slides that show them, using the table below. Keep the layout and wording; change only the figures.',
          input: '{{steps.data.text}}',
        },
      ],
    },
  },
  {
    id: 'monthly-report-section',
    nameKey: 'workspace.workflows.starter.monthlySection.name',
    blurbKey: 'workspace.workflows.starter.monthlySection.blurb',
    definition: {
      inputs: [{ id: 'url', label: 'Page', default: 'https://news.ycombinator.com' }],
      steps: [
        { id: 'fetch', type: 'fetch_page', urls: ['{{inputs.url}}'] },
        {
          id: 'summary',
          type: 'summarize',
          prompt: 'Summarize what is new on this page in a short paragraph and three bullet points.',
          input: '{{steps.fetch.text}}',
        },
        {
          id: 'report',
          type: 'edit_draft',
          // Picked in the editor: a starter cannot know which draft is yours.
          draft: '',
          instructions:
            "Add a section titled 'This month' at the end of the draft that presents the notes below. Leave the other sections as they are.",
          input: '{{steps.summary.text}}',
        },
      ],
    },
  },
  {
    id: 'weekly-research-digest',
    nameKey: 'workspace.workflows.starter.researchDigest.name',
    blurbKey: 'workspace.workflows.starter.researchDigest.blurb',
    definition: {
      inputs: [{ id: 'topic', label: 'Topic', default: 'local-first software' }],
      steps: [
        {
          id: 'research',
          type: 'research',
          question: '{{inputs.topic}}: what changed this week?',
          depth: 'quick',
        },
        {
          id: 'save',
          type: 'save_artifact',
          title: 'Weekly research digest',
          content: '{{steps.research.text}}',
          mode: 'update',
        },
        { id: 'notify', type: 'notify', title: 'Your research digest is ready', body: '{{steps.research.summary}}' },
      ],
    },
  },
  {
    id: 'new-posts-digest',
    nameKey: 'workspace.workflows.starter.newPosts.name',
    blurbKey: 'workspace.workflows.starter.newPosts.blurb',
    definition: {
      // Starts a run for each new post once "Run automatically" is on.
      trigger: { kind: 'feed', url: 'https://blog.rust-lang.org/feed.xml', everyMinutes: 30 },
      steps: [
        { id: 'fetch', type: 'fetch_page', urls: ['{{trigger.link}}'] },
        {
          id: 'summary',
          type: 'summarize',
          prompt: 'Summarize this post in four bullet points, then one sentence on who should read it.',
          input: '{{trigger.title}}\n\n{{steps.fetch.text}}',
        },
        {
          id: 'save',
          type: 'save_artifact',
          title: 'New post: {{trigger.title}}',
          content: '{{steps.summary.text}}\n\nSource: {{trigger.link}}',
          mode: 'create',
        },
        { id: 'notify', type: 'notify', title: 'New post', body: '{{trigger.title}}' },
      ],
    },
  },
  {
    id: 'inbox-folder',
    nameKey: 'workspace.workflows.starter.inboxFolder.name',
    blurbKey: 'workspace.workflows.starter.inboxFolder.blurb',
    definition: {
      // The folder is picked in the editor: a starter cannot know which one is yours.
      trigger: { kind: 'folder' },
      steps: [
        { id: 'file', type: 'read_file', path: '{{trigger.path}}' },
        {
          id: 'summary',
          type: 'summarize',
          prompt: 'Summarize this file in five bullet points and list any action items.',
          input: '{{steps.file.text}}',
        },
        { id: 'export', type: 'export_file', name: '{{trigger.name}} summary.md', content: '{{steps.summary.text}}' },
        { id: 'notify', type: 'notify', title: 'New file summarized', body: '{{trigger.name}}' },
      ],
    },
  },
  {
    id: 'check-notes-against-docs',
    nameKey: 'workspace.workflows.starter.checkNotes.name',
    blurbKey: 'workspace.workflows.starter.checkNotes.blurb',
    definition: {
      // Reads from the folder chosen in the editor, like any file step.
      inputs: [{ id: 'file', label: 'Notes file', default: 'notes.md' }],
      steps: [
        { id: 'notes', type: 'read_file', path: '{{inputs.file}}' },
        {
          id: 'docs',
          type: 'search_documents',
          // Picked in the editor: a starter cannot know which collections are yours.
          collections: [],
          query: '{{steps.notes.text}}',
          topK: 6,
        },
        {
          id: 'check',
          type: 'summarize',
          prompt:
            'Compare the notes with the passages from my documents. List what agrees, what conflicts and what the documents do not cover. Cite the document for each point.',
          input: 'Notes:\n{{steps.notes.text}}\n\nPassages:\n{{steps.docs.text}}',
        },
        { id: 'save', type: 'save_artifact', title: 'Notes check', content: '{{steps.check.text}}', mode: 'update' },
      ],
    },
  },
];
