/**
 * The Expo entry point.
 * ============================================================================
 *
 * WHY THIS FILE EXISTS AT ALL
 * ---------------------------
 * `package.json` used to carry `"main": "src/App.tsx"`, and `src/App.tsx` does
 * not export a component — it exports `MobileAppCoordinator`, a plain class.
 * Nothing read that field, so nothing complained; the moment Expo boots it, the
 * entry resolves to a value React cannot render.
 *
 * The coordinator is a good thing and is not being replaced: it is the piece
 * that knows how to sign in at a store, load its work and open a capture
 * session. It simply is not a component, and an entry point has to be one. So
 * this file exists to be the boundary between the two — it registers the shell,
 * and the shell talks to the coordinator.
 *
 * `registerRootComponent` rather than `AppRegistry.registerComponent` directly:
 * it is what sets up the root view, the error overlay in development, and the
 * `expo` runtime hooks that `expo-camera` and `expo-secure-store` need.
 */

import { registerRootComponent } from 'expo';

import { Root } from './Root';

registerRootComponent(Root);
