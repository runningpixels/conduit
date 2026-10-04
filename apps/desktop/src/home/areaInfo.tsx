/// What Home says about each area of the app: its icon, name, one-line
/// description, the live count it shows, the one thing to do there, and an
/// example to try while the area is still empty. Copy lives in the catalog
/// under `home.area.*` and `home.count.*`.

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
  WritingIcon,
} from '../icons';
import type { Destination } from '../shell/Rail';

/// The nine areas Home counts and explains, in the order Home lists them.
export const AREAS = ['chats', 'slides', 'writing', 'apps', 'documents', 'workflows', 'library', 'connectors', 'memory'] as const;
export type Area = (typeof AREAS)[number];

/// The things Home can ask the shell to do. The shell maps each to an
/// existing flow.
export type HomeAction =
  | 'new-chat'
  | 'start-deck'
  | 'start-draft'
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
  writing: <WritingIcon />,
  apps: <AppsIcon />,
  documents: <KnowledgeIcon />,
  workflows: <WorkflowIcon />,
  library: <SkillIcon />,
  connectors: <ConnectorsIcon />,
  memory: <MemoryIcon />,
};

/// The count a tile shows: a catalog key (plural over `{count}`) and where the
/// number comes from.
export type CountKey = 'chats' | 'decks' | 'drafts' | 'apps' | 'collections' | 'workflows' | 'prompts' | 'connectors' | 'memories';

export interface AreaInfo {
  area: Area;
  count: CountKey;
  /// The tile's one primary action.
  tileAction: HomeTarget;
  tileActionLabelId: string;
  /// Whether the area's example (`home.area.<area>.example`) works as a request
  /// in the ask box. When it does, clicking it puts it there; when it needs
  /// setting up first (a collection, a connector), it is only a hint.
  askable: boolean;
}

export const AREA_INFO: readonly AreaInfo[] = [
  { area: 'chats', count: 'chats', tileAction: { action: 'new-chat' }, tileActionLabelId: 'home.area.chats.action', askable: true },
  { area: 'slides', count: 'decks', tileAction: { action: 'start-deck' }, tileActionLabelId: 'home.area.slides.action', askable: true },
  { area: 'writing', count: 'drafts', tileAction: { action: 'start-draft' }, tileActionLabelId: 'home.area.writing.action', askable: false },
  { area: 'apps', count: 'apps', tileAction: { action: 'browse-apps' }, tileActionLabelId: 'home.area.apps.action', askable: true },
  { area: 'documents', count: 'collections', tileAction: { action: 'add-documents' }, tileActionLabelId: 'home.area.documents.action', askable: false },
  { area: 'workflows', count: 'workflows', tileAction: { action: 'new-workflow' }, tileActionLabelId: 'home.area.workflows.action', askable: false },
  { area: 'library', count: 'prompts', tileAction: { navigate: 'library' }, tileActionLabelId: 'home.area.library.action', askable: false },
  { area: 'connectors', count: 'connectors', tileAction: { action: 'add-connector' }, tileActionLabelId: 'home.area.connectors.action', askable: false },
  { area: 'memory', count: 'memories', tileAction: { action: 'review-memory' }, tileActionLabelId: 'home.area.memory.action', askable: true },
];

export type AreaCounts = Record<CountKey, number | null>;

export const EMPTY_COUNTS: AreaCounts = {
  chats: null,
  decks: null,
  drafts: null,
  apps: null,
  collections: null,
  workflows: null,
  prompts: null,
  connectors: null,
  memories: null,
};
