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
        { id: 'interests', label: 'What I care about', default: 'software development, AI, open source' },
        { id: 'language', label: 'Language', default: 'English' },
      ],
      steps: [
        { id: 'fetch', type: 'fetch_page', urls: ['{{inputs.site_one}}', '{{inputs.site_two}}'] },
        // A front page is only headlines, so the model picks the stories worth
        // reading from each page's text and links, and the loop below reads them.
        {
          id: 'pick',
          type: 'summarize',
          prompt:
            "You are choosing stories for a morning briefing. The reader cares about: {{inputs.interests}}.\n\nBelow are front pages, each with its text and its links (\"shown text - URL\"). Pick the 8 most important or interesting stories across all pages, at most 5 from one page. Prefer stories that matter to the reader; skip ads, sign-up prompts, navigation and duplicates of the same story.\n\nFor each story give: the headline as shown; the URL of the article itself, copied exactly from the links list; the name of the site whose front page listed it; and any numbers shown next to it, such as points or comments (empty if none).",
          input:
            '{{#each steps.fetch.pages}}# {{item.title}} ({{item.url}})\n{{item.error}}\n\n## Text\n{{item.text}}\n\n## Links\n{{item.linkText}}\n\n{{/each}}',
          schema: {
            type: 'object',
            properties: {
              stories: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    headline: { type: 'string' },
                    url: { type: 'string' },
                    source: { type: 'string' },
                    stats: { type: 'string' },
                  },
                  required: ['headline', 'url', 'source', 'stats'],
                },
              },
            },
            required: ['stories'],
          },
        },
        {
          id: 'read',
          type: 'for_each',
          items: 'steps.pick.data.stories',
          steps: [
            // A story whose page can't be read (a paywall, a dead link) is
            // skipped here and listed under "Also worth a look" instead.
            { id: 'article', type: 'fetch_page', urls: ['{{item.url}}'], onError: 'skip' },
            {
              id: 'gist',
              type: 'summarize',
              prompt:
                "Summarize this article for a morning briefing in 2 or 3 sentences: what happened, and the key detail or number. Then one sentence that starts with \"Why it matters:\" for a reader who cares about {{inputs.interests}}. Plain text, no headings. If the text below is not the article (a paywall, a cookie notice, an error page), reply only: Couldn't read the article.",
              input: '{{steps.article.text}}',
              onError: 'skip',
            },
            {
              id: 'card',
              type: 'template',
              // The link is written here, ready to copy, so the briefing keeps it.
              template: 'Link: [{{item.headline}}]({{item.url}})\nSite: {{item.source}} {{item.stats}}\nSummary: {{steps.gist.text}}',
              onError: 'skip',
            },
          ],
        },
        {
          id: 'write',
          type: 'summarize',
          prompt:
            "Write today's morning briefing in Markdown, in {{inputs.language}}, for a reader who cares about: {{inputs.interests}}.\n\nStart with a \"# \" heading that says \"Morning briefing\" in {{inputs.language}}, then a comma and {{run.date}}. Then a short opening paragraph (2 or 3 sentences) on the main threads of the day. Then group the stories under 2 to 4 \"## \" headings by theme. For each story, three paragraphs separated by blank lines: its Link exactly as given, in bold, followed by the site (and its numbers, if any) in italics; its summary; and why it matters. Put stories with no summary, or whose summary says the article couldn't be read, in a last section headed \"Also worth a look\" (in {{inputs.language}}) as a list of links.\n\nUse only the facts in the stories below. Don't add any. Keep each Link's headline as given, even if it is in another language.",
          input: '{{#each steps.read.items}}{{item.card.text}}\n\n{{/each}}',
        },
        // A new document every morning, so each briefing stays in Results.
        {
          id: 'save',
          type: 'save_artifact',
          title: 'Morning briefing {{run.date}}',
          content: '{{steps.write.text}}',
          mode: 'create',
        },
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
