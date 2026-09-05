import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConnectorsSection } from './ConnectorsSection';

const {
  getConnectorRuntimeStates,
  listConnectorCapabilities,
  listConnectorGrants,
  listToolApprovalMemory,
  searchMcpRegistry,
  addRemoteConnector,
  signinRemoteConnector,
} = vi.hoisted(() => ({
  getConnectorRuntimeStates: vi.fn(),
  listConnectorCapabilities: vi.fn(),
  listConnectorGrants: vi.fn(),
  listToolApprovalMemory: vi.fn(),
  searchMcpRegistry: vi.fn(),
  addRemoteConnector: vi.fn(),
  signinRemoteConnector: vi.fn(),
}));

vi.mock('../../ipc/client', () => ({
  getConnectorRuntimeStates,
  listConnectorCapabilities,
  listConnectorGrants,
  listToolApprovalMemory,
  searchMcpRegistry,
  addRemoteConnector,
  signinRemoteConnector,
  addLocalConnector: vi.fn(),
  discoverConnector: vi.fn(),
  startConnector: vi.fn(),
  stopConnector: vi.fn(),
  revokeConnectorGrant: vi.fn(),
  revokeToolApprovalMemory: vi.fn(),
}));

describe('ConnectorsSection registry + remote HTTP', () => {
  beforeEach(() => {
    getConnectorRuntimeStates.mockResolvedValue([]);
    listConnectorCapabilities.mockResolvedValue([]);
    listConnectorGrants.mockResolvedValue([]);
    listToolApprovalMemory.mockResolvedValue([]);
    searchMcpRegistry.mockResolvedValue([]);
    addRemoteConnector.mockResolvedValue({ connectorId: 'remote:acme', connectorVersionId: 'remote:acme:1.0.0' });
    signinRemoteConnector.mockResolvedValue(undefined);
  });

  it('installs an official-registry streamable HTTP server', async () => {
    searchMcpRegistry.mockResolvedValue([
      {
        name: 'com.example/acme',
        title: 'ACME',
        description: 'analytics',
        version: '2.0.0',
        remoteUrl: 'https://analytics.example.com/mcp',
        remoteType: 'streamable-http',
        installable: true,
      },
    ]);
    const onStatus = vi.fn();
    render(<ConnectorsSection onStatus={onStatus} />);
    await waitFor(() => {
      expect(getConnectorRuntimeStates).toHaveBeenCalled();
    });
    fireEvent.change(screen.getByPlaceholderText('Search remote servers'), {
      target: { value: 'acme' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('ACME')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    await waitFor(() => {
      expect(addRemoteConnector).toHaveBeenCalledWith({
        name: 'ACME',
        description: 'analytics',
        url: 'https://analytics.example.com/mcp',
        version: '2.0.0',
      });
    });
  });

  it('shows Sign in for a remote connector that needs OAuth', async () => {
    getConnectorRuntimeStates.mockResolvedValue([
      {
        connectorVersionId: 'remote:acme:1.0.0',
        connectorId: 'remote:acme',
        connectorName: 'ACME',
        version: '1.0.0',
        transport: 'httpSse',
        health: 'authRequired',
        lastError: 'MCP server requires authentication',
        restartCount: 0,
        grantStatus: 'active',
        supportState: 'available',
        running: false,
      },
    ]);
    render(<ConnectorsSection onStatus={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    await waitFor(() => {
      expect(signinRemoteConnector).toHaveBeenCalledWith('remote:acme:1.0.0');
    });
  });
});
