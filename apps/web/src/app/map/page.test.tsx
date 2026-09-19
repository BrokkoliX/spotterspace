import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import { AuthProvider } from '../../lib/auth';

// ─── Mock mapbox-gl ──────────────────────────────────────────────────────────

// Exported so tests can control the mock map instance
export const mockMapInstance = {
  on: vi.fn(),
  off: vi.fn(),
  getBounds: vi.fn(() => ({
    getSouthWest: () => ({ lat: () => 47.0, lng: () => -123.0 }),
    getNorthEast: () => ({ lat: () => 48.0, lng: () => -122.0 }),
    getWest: () => -123.0,
    getSouth: () => 47.0,
    getEast: () => -122.0,
    getNorth: () => 48.0,
  })),
  getZoom: vi.fn(() => 2),
  flyTo: vi.fn(),
  addControl: vi.fn(),
  remove: vi.fn(),
  _listeners: {} as Record<string, Array<(...args: unknown[]) => void>>,
};

// Self-contained mock — deliberately does NOT call importOriginal().
// mapbox-gl is a WebGL library whose UMD bundle crashes when evaluated under
// jsdom ("Cannot read properties of undefined (reading '_buffer')"). The app
// only touches Map / Marker / Popup / NavigationControl / accessToken, all of
// which are defined below, so pulling in the real module bought nothing.
vi.mock('mapbox-gl', () => {
  const mapboxMock = {
    accessToken: 'pk.test-token',
    Map: vi.fn(function () {
      const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
      mockMapInstance.on = vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        listeners[event] = listeners[event] ?? [];
        listeners[event].push(cb);
      });
      mockMapInstance.off = vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        listeners[event] = (listeners[event] ?? []).filter((l) => l !== cb);
      });
      mockMapInstance._listeners = listeners;
      return mockMapInstance;
    }),
    Marker: vi.fn(function () {
      return {
        setLngLat: vi.fn().mockReturnThis(),
        setPopup: vi.fn().mockReturnThis(),
        addTo: vi.fn().mockReturnThis(),
        remove: vi.fn(),
      };
    }),
    Popup: vi.fn(function () {
      return {
        setHTML: vi.fn().mockReturnThis(),
        setMaxWidth: vi.fn().mockReturnThis(),
      };
    }),
    NavigationControl: vi.fn(function () {
      return {};
    }),
  };
  return { ...mapboxMock, default: mapboxMock };
});

vi.mock('mapbox-gl/dist/mapbox-gl.css', () => ({}));

vi.mock('supercluster', () => ({
  default: vi.fn(() => ({ load: vi.fn(), getClusters: vi.fn(() => []) })),
}));

// ─── Tests ───────────────────────────────────────────────────────────────────

// MAPBOX_TOKEN is a module-level const read from process.env at import time,
// so we must set process.env BEFORE importing the module and reset modules
// between tests to re-evaluate the const.
async function getMapPage() {
  const mod = await import('./page');
  return mod.default;
}

describe('MapPage no token', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_MAPBOX_TOKEN = 'pk.your_mapbox_token';
  });

  it('renders placeholder UI when token is the placeholder value', async () => {
    const MapPage = await getMapPage();
    render(
      <AuthProvider>
        <MapPage />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('Mapbox Token Required')).toBeTruthy();
    });
  });

  it('shows env var instructions in placeholder', async () => {
    const MapPage = await getMapPage();
    render(
      <AuthProvider>
        <MapPage />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText(/NEXT_PUBLIC_MAPBOX_TOKEN/)).toBeTruthy();
    });
  });
});

describe('MapPage with token', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_MAPBOX_TOKEN = 'pk.test-token';
  });

  it('initializes Map with correct options', async () => {
    const mapboxgl = await import('mapbox-gl');
    const MapPage = await getMapPage();
    render(
      <AuthProvider>
        <MapPage />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(mapboxgl.default.Map).toHaveBeenCalled();
    });
  });
});
