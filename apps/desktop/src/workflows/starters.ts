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
];
