/// What Home says about each area of the app: its icon, name, one-line
/// description, the live count it shows, and the one thing to do there. Copy
/// lives in the catalog under `home.area.*`, `home.count.*` and `home.job.*`.

import type { ReactNode } from 'react';
import {
  AppsIcon,
  ChatIcon,
  ConnectorsIcon,
  KnowledgeIcon,
  MemoryIcon,
  SkillIcon,
  SlidesIcon,
  WorkflowIcon,
} from '../icons';
import type { Destination } from '../shell/Rail';
import type { Area } from './visitedAreas';

/// The things Home can ask the shell to do. The shell maps each to an
/// existing flow.
export type HomeAction =
  | 'new-chat'
  | 'start-deck'
  | 'add-documents'
  | 'new-workflow'
  | 'add-connector'
  | 'browse-apps'
  | 'review-memory'
  | 'open-reviews';

/// What a button on Home does: open an area, or run an action.
export type HomeTarget = { navigate: Destination } | { action: HomeAction };

export const AREA_ICONS: Record<Area, ReactNode> = {
  chats: <ChatIcon />,
  slides: <SlidesIcon />,
  apps: <AppsIcon />,
  documents: <KnowledgeIcon />,
  workflows: <WorkflowIcon />,
  library: <SkillIcon />,
  connectors: <ConnectorsIcon />,
  memory: <MemoryIcon />,
};

/// The count a tile shows: a catalog key (plural over `{count}`) and where the
/// number comes from.
export type CountKey = 'chats' | 'decks' | 'apps' | 'collections' | 'workflows' | 'prompts' | 'connectors' | 'memories';

export interface AreaInfo {
  area: Area;
  count: CountKey;
  /// The compact tile's one primary action.
  tileAction: HomeTarget;
  tileActionLabelId: string;
}

export const AREA_INFO: readonly AreaInfo[] = [
  { area: 'chats', count: 'chats', tileAction: { action: 'new-chat' }, tileActionLabelId: 'home.area.chats.action' },
  { area: 'slides', count: 'decks', tileAction: { action: 'start-deck' }, tileActionLabelId: 'home.area.slides.action' },
  { area: 'apps', count: 'apps', tileAction: { action: 'browse-apps' }, tileActionLabelId: 'home.area.apps.action' },
  { area: 'documents', count: 'collections', tileAction: { action: 'add-documents' }, tileActionLabelId: 'home.area.documents.action' },
  { area: 'workflows', count: 'workflows', tileAction: { action: 'new-workflow' }, tileActionLabelId: 'home.area.workflows.action' },
  { area: 'library', count: 'prompts', tileAction: { navigate: 'library' }, tileActionLabelId: 'home.area.library.action' },
  { area: 'connectors', count: 'connectors', tileAction: { action: 'add-connector' }, tileActionLabelId: 'home.area.connectors.action' },
  { area: 'memory', count: 'memories', tileAction: { action: 'review-memory' }, tileActionLabelId: 'home.area.memory.action' },
];

/// One job card in the guide: what you can get done, in a sentence, with a
/// real prompt to try and where to start.
export interface JobCard {
  id: string;
  area: Area;
  start: HomeTarget;
}

export const JOB_CARDS: readonly JobCard[] = [
  { id: 'story', area: 'slides', start: { action: 'start-deck' } },
  { id: 'tool', area: 'apps', start: { action: 'browse-apps' } },
  { id: 'files', area: 'documents', start: { action: 'add-documents' } },
  { id: 'automate', area: 'workflows', start: { action: 'new-workflow' } },
  { id: 'prompts', area: 'library', start: { navigate: 'library' } },
  { id: 'connect', area: 'connectors', start: { action: 'add-connector' } },
  { id: 'remember', area: 'memory', start: { navigate: 'memory' } },
  { id: 'think', area: 'chats', start: { action: 'new-chat' } },
];

export type AreaCounts = Record<CountKey, number | null>;

export const EMPTY_COUNTS: AreaCounts = {
  chats: null,
  decks: null,
  apps: null,
  collections: null,
  workflows: null,
  prompts: null,
  connectors: null,
  memories: null,
};
