# Geofence attendance – backend update (test deployment)

This package adds backend support, **not background tracking in Flutter**. A Flutter Android/iOS application must be built with native background geofence support, appropriate platform permissions, clear user consent, and delivery/retry handling. Vercel/Flutter Web and a stationary office PC cannot provide reliable background exits.

## Safety and rollout

- Geofencing is **disabled by default**. Existing ZKTeco and manual attendance remain available.
- Use an isolated test MongoDB database and test employees. Back up the database before deploying.
- A phone must opt in (`POST /api/me/geofence/enroll`), and registering a new phone disables previous enrolled phones for that employee.
- Do not present geofence arrival/departure as precise or guaranteed: mobile OS delays, battery optimizations, mock coordinates, shared phones, and GPS errors can affect results.
- This API verifies coordinates, freshness (2 minutes), accuracy, distance, and a sustained zone period; it does **not cryptographically attest that the reported GPS coordinates are genuine**. For production consider device attestation, anti-spoofing policy, audit and privacy review.
- Note: a geofence exit may close a session originally opened by ZKTeco or PC. A geofence entry may open a new session; confirm your attendance/shift rules first.

## Admin – update existing Rules API

Authenticated user with `rules.edit` permission:

```http
PUT /api/rules
Content-Type: application/json
Authorization: Bearer <admin token>

{
  "geofenceEnabled": true,
  "geofenceAutoCheckIn": true,
  "geofenceAutoCheckOut": true,
  "geofenceLatitude": 8.5241,
  "geofenceLongitude": 76.9366,
  "geofenceRadiusMeters": 150,
  "geofenceMaxAccuracyMeters": 50,
  "geofenceConfirmSeconds": 60
}
```

Coordinates are **examples only**. Set actual office coordinates. The backend uses the existing noon and evening checkout scheduling rules for each IN.

## Mobile integration API

All endpoints use an authenticated employee's existing Bearer token and normal employee self-service permissions.

1. `GET /api/me/geofence/config?deviceId=registered-phone-001` -> office center, radius, settings and that device's status.
2. `POST /api/me/geofence/enroll` with `{ "deviceId": "registered-phone-001", "consent": true }` -> opts in that phone. Use a persistent random *app installation* ID, not IMEI.
3. `POST /api/me/geofence/reading` with:

```json
{
  "deviceId": "registered-phone-001",
  "location": {
    "latitude": 8.5241,
    "longitude": 76.9366,
    "accuracyMeters": 15,
    "capturedAt": "2026-10-31T06:30:00Z"
  }
}
```

The timestamp must be generated at capture time. The backend returns `zone` (`INSIDE`, `OUTSIDE` or `UNCERTAIN`), `action` (`NONE`, `CHECKED_IN`, `CHECKED_OUT`) and `distanceMeters`. To trigger a transition, send at least two qualifying readings in the same zone, at least 10 seconds apart and separated by `geofenceConfirmSeconds` elapsed time. **App/OS geofence transitions alone do not create punches**; readings must reach the server.

4. `POST /api/me/geofence/disable` with `{ "deviceId": "registered-phone-001" }` -> revoke device geofencing consent.

### Important remaining work for production

- Flutter native Android/iOS background geofencing, permission prompts and disclosure/opt-out UX are **not in this ZIP**.
- This initial backend integration uses the current latest daily status and `webCheckIn/webCheckOut` service to prevent ordinary duplicate punches. Concurrent device/geofence events may still race; before high-volume production use, add transactional/per-employee atomic attendance state changes and idempotent event IDs.
- Add admin UI for geofence settings, expose geofence indicators in reports, and thoroughly test noon/end-of-day, shifts, offline and late-arriving F28 events.
- Location details are stored for attendance; establish retention, access-control and privacy policies.
