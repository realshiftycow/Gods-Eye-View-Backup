// src/ui/cockpitEntryGate.test.mjs — first person needs only the layer of
// the vehicle it rides: Contacts and the other feeds may be off before or
// during a session, turning the ridden layer off ends it, and the voice gate
// and state say so without claiming Contacts is required. Over happy-dom.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia } from 'pinia';
import { createApp, defineComponent, h, nextTick } from 'vue';
import { CockpitCoordinator } from './cockpitCoordinator.js';
import { _handleContextLayerChange } from './contextLayerChanges.js';
import { useCockpitStore } from './stores/cockpit.js';
import { useHudStore } from './stores/hud.js';
import ContextView from './views/ContextView.vue';
import IntelHudView from './views/IntelHudView.vue';

const CIVIL = Object.freeze({
  icao24: 'abc123',
  callsign: 'UAL123',
  track: 92,
  latitude: 30,
  longitude: -97,
});
/** A tracked satellite, as the Satellites layer reports it. */
const SATELLITE = Object.freeze({
  kind: 'satellite',
  layerId: 'satellites',
  id: '25544',
  noradId: 25544,
  name: 'ISS (ZARYA)',
  classLabel: 'STATION · ISS',
  latitude: 30,
  longitude: -97,
  altitudeM: 420_000,
  velocityMps: 7_660,
  stale: false,
});
const MILITARY = Object.freeze({
  ...CIVIL,
  icao24: 'ae0001',
  callsign: 'RCH1',
});

function fixture(
  t,
  {
    enabled = [],
    tracked = null,
    satellite = null,
    contextMode = null,
    changing = false,
  } = {},
) {
  document.body.replaceChildren();
  const host = document.body.appendChild(document.createElement('div'));
  const pinia = createPinia();
  const app = createApp(
    defineComponent(() => () => [h(ContextView), h(IntelHudView)]),
  ).use(pinia);
  app.mount(host);
  const store = useCockpitStore(pinia);
  const layers = new Set(enabled);
  const dataManager = { isEnabled: (layerId) => layers.has(layerId) };
  // A layer that is off has no tracked aircraft, as the flight layers clear
  // tracking on disable.
  const trackedFrom = (layerId) => () =>
    tracked?.layerId === layerId && layers.has(layerId) ? tracked.info : null;
  const entity = {
    position: { getValue: () => null },
    show: true,
    gevTrackedId: tracked ? `${tracked.layerId}:${tracked.info.icao24}` : '',
  };
  const listeners = () => ({ addEventListener: () => () => {} });
  const viewer = {
    trackedEntity: tracked ? entity : undefined,
    clock: { currentTime: null },
    camera: { cancelFlight() {}, frustum: { fov: 1, aspectRatio: 1 } },
    entities: { contains: (candidate) => candidate === entity },
    scene: {
      preUpdate: listeners(),
      screenSpaceCameraController: { enableInputs: true },
    },
    trackedEntityChanged: listeners(),
  };
  const context = { mode: contextMode, changing };
  const coordinator = new CockpitCoordinator({
    viewer,
    services: {
      flightsLayer: { getTrackedInfo: trackedFrom('flights') },
      militaryFlightsLayer: { getTrackedInfo: trackedFrom('military') },
      aisLiveVesselsLayer: { getCockpitSubject: () => null },
      // Like the layer, no subject while Satellites is off.
      satellitesLayer: {
        getCockpitSubject: () =>
          satellite && layers.has('satellites') ? { ...satellite } : null,
        getCockpitPosition: () => null,
        setCockpitSubject: () => true,
      },
      militaryAwarenessLayer: { getContextSnapshot: () => null },
      isTr3b: () => false,
      holdContinuousRender() {},
      releaseContinuousRender() {},
    },
    elements: {},
    operations: {
      publishCockpit: { presence: (view) => store.publishPresence(view) },
      _stampNavigation() {},
      getAircraftTrackingTarget: () =>
        tracked ? { layerId: tracked.layerId, id: tracked.info.icao24 } : null,
    },
    readDataManager: () => dataManager,
    readContext: () => context,
    readActiveStyle: () => 'normal',
    readUtilityDisclosureOpen: () => false,
    enterPanels() {},
    exitPanels() {},
  });
  const cockpit = coordinator.cockpitView;
  // The HUD, briefing and signals have their own tests.
  Object.assign(cockpit, {
    updateHud() {},
    setVisionMode() {},
    showBriefPage() {},
    startBriefRotation() {},
    stopBriefRotation() {},
    pushCockpitSignal() {},
    scheduleContextLayout() {},
    clearPredictiveRoute() {},
  });
  t.after(() => {
    coordinator.stop();
    app.unmount();
    document.body.classList.remove(
      'cockpit-mode',
      'cockpit-bridge',
      'cockpit-orbit',
    );
  });
  /** Turn a layer off and tell the Context owner, as the data manager does. */
  const disable = (layerId) => {
    layers.delete(layerId);
    _handleContextLayerChange.call(
      {
        cockpitView: cockpit,
        _dataManager: dataManager,
        _contextMode: null,
        _contextModeChanging: false,
        _contextSessionSnapshot: null,
        _contextRestoreState: null,
        _syncContextModeButtons() {},
      },
      { type: 'visibility', layerId, enabled: false, origin: 'user' },
    );
  };
  const $ = (selector) => document.querySelector(selector);
  return { $, coordinator, cockpit, store, layers, disable, pinia };
}

test('a civilian aircraft enters with Live Flights alone: no Contacts, no Military', (t) => {
  const { coordinator, cockpit } = fixture(t, {
    enabled: ['flights'],
    tracked: { layerId: 'flights', info: CIVIL },
  });
  const state = coordinator.getCockpitState();
  assert.equal(state.entryAllowed, true);
  assert.equal(state.entryBlockedReason, null);
  assert.equal(cockpit.enter(), true);
  assert.equal(cockpit.subjectKind, 'aircraft');
});

test('a military aircraft enters with Military Flights alone', (t) => {
  const { coordinator, cockpit } = fixture(t, {
    enabled: ['military'],
    tracked: { layerId: 'military', info: MILITARY },
  });
  assert.equal(coordinator.getCockpitState().entryAllowed, true);
  assert.equal(cockpit.enter(), true);
});

test('a Context change in flight still blocks entry, and says so', (t) => {
  const { coordinator, cockpit } = fixture(t, {
    enabled: ['flights', 'military'],
    tracked: { layerId: 'flights', info: CIVIL },
    contextMode: 'flights',
    changing: true,
  });
  const state = coordinator.getCockpitState();
  assert.equal(state.entryAllowed, false);
  assert.equal(state.entryBlockedReason, 'contacts-starting');
  assert.equal(cockpit.enter(), false);
  const voice = coordinator.controlCockpit('enter');
  assert.equal(voice.ok, false);
  assert.match(voice.error, /Context is still changing/);
  assert.equal(cockpit.active, false);
});

test('with no aircraft layer on, entry is refused for that reason, never for Contacts', (t) => {
  const { coordinator, cockpit } = fixture(t);
  const state = coordinator.getCockpitState();
  assert.equal(state.entryBlockedReason, 'subject-layer-off');
  const voice = coordinator.controlCockpit('enter');
  assert.equal(voice.ok, false);
  assert.match(voice.error, /No aircraft layer is on/);
  assert.doesNotMatch(voice.error, /contacts/i);
  assert.equal(voice.state.entryBlockedReason, 'subject-layer-off');
  assert.equal(cockpit.active, false);
});

test('with an aircraft layer on but nothing tracked, the reason is the missing aircraft', (t) => {
  const { coordinator } = fixture(t, { enabled: ['military'] });
  assert.equal(
    coordinator.getCockpitState().entryBlockedReason,
    'no-tracked-aircraft',
  );
});

test('voice enters without Contacts when the ridden layer is on', (t) => {
  const { coordinator, cockpit } = fixture(t, {
    enabled: ['flights'],
    tracked: { layerId: 'flights', info: CIVIL },
  });
  const result = coordinator.controlCockpit('enter');
  assert.equal(result.ok, true, result.error);
  assert.equal(cockpit.active, true);
});

test('other layers may be turned off during a session; the ridden layer ends it', (t) => {
  const { cockpit, disable } = fixture(t, {
    enabled: ['flights', 'military', 'ais-live-vessels'],
    tracked: { layerId: 'flights', info: CIVIL },
  });
  assert.equal(cockpit.enter(), true);
  disable('military');
  disable('ais-live-vessels');
  assert.equal(cockpit.active, true, 'other feeds are free to go off');
  disable('flights');
  assert.equal(cockpit.active, false, 'the ridden layer going off ends it');
});

test('the readout offers the same entry, labelled by kind, and enters on click', async (t) => {
  const { $, cockpit, pinia } = fixture(t, {
    enabled: ['flights'],
    tracked: { layerId: 'flights', info: CIVIL },
  });
  useHudStore(pinia);
  const readoutEntry = $('#cockpit-entry-readout');
  assert.equal(readoutEntry.hidden, true, 'hidden until entry is available');
  cockpit.syncEntry();
  await nextTick();
  assert.equal(readoutEntry.hidden, false);
  assert.match(readoutEntry.textContent, /flight/);
  assert.match(readoutEntry.textContent, /COCKPIT/);
  assert.equal(
    $('#cockpit-entry').hidden,
    false,
    'the Contacts entry follows the same presence',
  );
  readoutEntry.click();
  await nextTick();
  assert.equal(cockpit.active, true);
  assert.equal(readoutEntry.hidden, true, 'inside, there is nothing to enter');
});

test('the readout entry reads BRIDGE for a selected vessel', async (t) => {
  const { $, store } = fixture(t);
  store.publishPresence({
    active: false,
    entryAvailable: true,
    entryKind: 'vessel',
    subjectKind: null,
    tr3b: null,
  });
  await nextTick();
  const readoutEntry = $('#cockpit-entry-readout');
  assert.equal(readoutEntry.hidden, false);
  assert.match(readoutEntry.textContent, /directions_boat/);
  assert.match(readoutEntry.textContent, /BRIDGE/);
});

test('a tracked satellite needs Satellites on for the ORBIT entry', async (t) => {
  const { $, cockpit } = fixture(t, { satellite: SATELLITE });
  cockpit.syncEntry();
  await nextTick();
  assert.equal($('#cockpit-entry').hidden, true, 'Satellites off: no entry');
  assert.equal(cockpit.enter(), false);
});

test('with Satellites on, the tracked satellite offers ORBIT and reports itself', async (t) => {
  const { $, cockpit, coordinator, pinia } = fixture(t, {
    enabled: ['satellites'],
    satellite: SATELLITE,
  });
  useHudStore(pinia);
  cockpit.syncEntry();
  await nextTick();
  for (const selector of ['#cockpit-entry', '#cockpit-entry-readout']) {
    assert.equal($(selector).hidden, false, selector);
    assert.match($(selector).textContent, /satellite_alt/);
    assert.match($(selector).textContent, /ORBIT/);
  }
  // Voice stays aircraft-only: it neither offers nor takes the satellite.
  assert.equal(coordinator.getCockpitState().entryAllowed, false);
  assert.equal(coordinator.controlCockpit('enter').ok, false);
  assert.equal(cockpit.active, false);
  $('#cockpit-entry-readout').click();
  await nextTick();
  assert.equal(cockpit.active, true);
  assert.equal(cockpit.subjectKind, 'satellite');
  const state = coordinator.getCockpitState();
  assert.equal(state.active, true);
  assert.deepEqual(state.subject, {
    kind: 'satellite',
    id: '25544',
    layerId: 'satellites',
    callsign: null,
    name: 'ISS (ZARYA)',
  });
});

test('tracked debris offers no ORBIT entry and refuses to be entered', async (t) => {
  const { $, cockpit } = fixture(t, {
    enabled: ['satellites'],
    satellite: {
      ...SATELLITE,
      id: '27386',
      noradId: 27386,
      name: 'SL-16 R/B',
      satelliteClass: 'debris',
      enterable: false,
    },
  });
  cockpit.syncEntry();
  await nextTick();
  for (const selector of ['#cockpit-entry', '#cockpit-entry-readout'])
    assert.equal($(selector).hidden, true, selector);
  assert.equal(cockpit.enter(), false);
  assert.equal(cockpit.enter({ kind: 'satellite' }), false);
  assert.equal(cockpit.active, false);
});

test('a Context change in flight blocks the orbital view too', (t) => {
  const { cockpit } = fixture(t, {
    enabled: ['satellites'],
    satellite: SATELLITE,
    changing: true,
  });
  assert.equal(cockpit.enter(), false);
});

test('turning Satellites off ends the orbital view', (t) => {
  const { cockpit, disable } = fixture(t, {
    enabled: ['satellites', 'flights'],
    satellite: SATELLITE,
  });
  assert.equal(cockpit.enter(), true);
  disable('flights');
  assert.equal(cockpit.active, true, 'other feeds are free to go off');
  disable('satellites');
  assert.equal(cockpit.active, false);
});
