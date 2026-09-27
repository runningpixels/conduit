import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ConnectorRuntimeSnapshot } from '../ipc/contracts';
import { ConnectorsPage } from './ConnectorsPage';

const ipc = vi.hoisted(() => ({
  getConnectorRuntimeStates: vi.fn(),
  listConnectorCapabilities: vi.fn(),
  listConnectorGrants: vi.fn(),
  listToolApprovalMemory: vi.fn(),
  searchMcpRegistry: vi.fn(),
  addRemoteConnector: vi.fn(),
  addLocalConnector: vi.fn(),
  signinRemoteConnector: vi.fn(),
  discoverConnector: vi.fn(),
  startConnector: vi.fn(),
  stopConnector: vi.fn(),
  revokeConnectorGrant: vi.fn(),
  revokeToolApprovalMemory: vi.fn(),
}));

vi.mock('../ipc/client', () => ipc);

function snapshot(overrides: Partial<ConnectorRuntimeSnapshot>): ConnectorRuntimeSnapshot {
  return {
    connectorVersionId: 'local:echo:1.0.0',
    connectorId: 'local:echo',
    connectorName: 'Echo',
    version: '1.0.0',
    transport: 'stdio',
    restartCount: 0,
    grantStatus: 'active',
    supportState: 'available',
    running: false,
    ...overrides,
  };
}

const echo = snapshot({});
const acme = snapshot({
  connectorVersionId: 'remote:acme:2.0.0',
  connectorId: 'remote:acme',
  connectorName: 'ACME',
  version: '2.0.0',
  transport: 'httpSse',
  running: true,
  health: 'healthy',
});

describe('ConnectorsPage', () => {
  beforeEach(() => {
    for (const fn of Object.values(ipc)) fn.mockReset();
    ipc.getConnectorRuntimeStates.mockResolvedValue([]);
    ipc.listConnectorCapabilities.mockResolvedValue([]);
    ipc.listConnectorGrants.mockResolvedValue([]);
    ipc.listToolApprovalMemory.mockResolvedValue([]);
    ipc.searchMcpRegistry.mockResolvedValue([]);
    ipc.startConnector.mockResolvedValue({ name: 'echo', version: '1.0.0' });
    ipc.revokeConnectorGrant.mockResolvedValue(undefined);
    ipc.revokeToolApprovalMemory.mockResolvedValue(true);
    ipc.addRemoteConnector.mockResolvedValue({ connectorId: 'remote:new', connectorVersionId: 'remote:new:1' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the empty state, whose action opens the add flow', async () => {
    render(<ConnectorsPage onStatus={vi.fn()} />);
    const empty = await screen.findByText('No connectors yet');
    const emptyBox = empty.closest('.page-empty') as HTMLElement;
    fireEvent.click(within(emptyBox).getByRole('button', { name: 'Add connector' }));
    expect(screen.getByRole('heading', { name: 'Add a connector' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Search remote servers')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add local connector' })).toBeInTheDocument();
  });

  it('selects the first connector by default and switches on click', async () => {
    ipc.getConnectorRuntimeStates.mockResolvedValue([echo, acme]);
    ipc.listConnectorCapabilities.mockImplementation(async (id: string) =>
      id === acme.connectorVersionId
        ? [
            { id: 'c1', connectorVersionId: id, kind: 'tool', name: 'query', discoveredAt: '' },
            { id: 'c2', connectorVersionId: id, kind: 'prompt', name: 'summarize', schemaJson: { description: 'Sum it up' }, discoveredAt: '' },
          ]
        : [],
    );
    ipc.listToolApprovalMemory.mockResolvedValue([
      { id: 'a1', toolKey: `${acme.connectorVersionId}::query`, scope: 'always', conversationId: null, createdAt: '' },
    ]);
    render(<ConnectorsPage onStatus={vi.fn()} />);
    expect(await screen.findByRole('heading', { name: 'Echo' })).toBeInTheDocument();
    const list = screen.getByRole('navigation', { name: 'Connectors' });
    expect(within(list).getByRole('button', { name: /Echo/ })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByText(/Nothing discovered yet/)).toBeInTheDocument();

    await waitFor(() => expect(within(list).getByRole('button', { name: /ACME/ })).toHaveTextContent('1 tool'));
    fireEvent.click(within(list).getByRole('button', { name: /ACME/ }));
    expect(screen.getByRole('heading', { name: 'ACME' })).toBeInTheDocument();
    // Once under Tools, once under its remembered approval.
    expect(screen.getAllByText('query')).toHaveLength(2);
    expect(screen.getByText('Always allowed')).toBeInTheDocument();
    expect(screen.getByText('Sum it up')).toBeInTheDocument();
  });

  it('starts a stopped connector', async () => {
    const onStatus = vi.fn();
    ipc.getConnectorRuntimeStates.mockResolvedValue([echo]);
    render(<ConnectorsPage onStatus={onStatus} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
    await waitFor(() => expect(ipc.startConnector).toHaveBeenCalledWith(echo.connectorVersionId));
    expect(onStatus).toHaveBeenCalledWith('Started Echo');
  });

  it('offers Sign in for a connector that needs OAuth', async () => {
    ipc.getConnectorRuntimeStates.mockResolvedValue([snapshot({ health: 'authRequired', transport: 'httpSse' })]);
    ipc.signinRemoteConnector.mockResolvedValue(undefined);
    render(<ConnectorsPage onStatus={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(ipc.signinRemoteConnector).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument();
  });

  it('revokes the grant after confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    ipc.getConnectorRuntimeStates.mockResolvedValue([echo]);
    ipc.listConnectorGrants.mockResolvedValue([{ id: 'g1', connectorVersionId: echo.connectorVersionId, scope: 'user', status: 'active' }]);
    render(<ConnectorsPage onStatus={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(ipc.revokeConnectorGrant).toHaveBeenCalledWith('g1', echo.connectorVersionId));
  });

  it('lists every remembered approval and forgets one', async () => {
    ipc.listToolApprovalMemory.mockResolvedValue([
      { id: 'a9', toolKey: 'builtin::web_search', scope: 'thisChat', conversationId: 'c1', createdAt: '' },
    ]);
    const onStatus = vi.fn();
    render(<ConnectorsPage onStatus={onStatus} />);
    const list = await screen.findByRole('navigation', { name: 'Connectors' });
    await waitFor(() => expect(within(list).getByRole('button', { name: /Remembered tool approvals/ })).toHaveTextContent('1 tool'));
    fireEvent.click(within(list).getByRole('button', { name: /Remembered tool approvals/ }));
    expect(screen.getByText('web_search')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Forget' }));
    await waitFor(() => expect(ipc.revokeToolApprovalMemory).toHaveBeenCalledWith('a9'));
    await waitFor(() => expect(onStatus).toHaveBeenCalledWith('Forgot approval for web_search'));
  });

  it('adds a remote connector from the header action, validating first', async () => {
    const onStatus = vi.fn();
    ipc.getConnectorRuntimeStates.mockResolvedValue([echo]);
    render(<ConnectorsPage onStatus={onStatus} />);
    await screen.findByRole('heading', { name: 'Echo' });
    fireEvent.click(screen.getByRole('button', { name: 'Add connector' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add remote connector' }));
    expect(onStatus).toHaveBeenCalledWith('Remote connector name and URL are required');
    expect(ipc.addRemoteConnector).not.toHaveBeenCalled();

    fireEvent.change(screen.getByPlaceholderText('Remote connector name'), { target: { value: 'New' } });
    fireEvent.change(screen.getByLabelText(/Streamable HTTP URL/), { target: { value: 'https://x.example/mcp' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add remote connector' }));
    await waitFor(() =>
      expect(ipc.addRemoteConnector).toHaveBeenCalledWith({ name: 'New', url: 'https://x.example/mcp' }),
    );
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Add a connector' })).not.toBeInTheDocument());
  });
});
