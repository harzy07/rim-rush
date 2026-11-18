# Rim Rush: Devpost submission draft

Replace everything in [brackets] before submitting.

**Name:** Rim Rush

**Tagline (max 140 chars):**
Wheelchair Snake on your real table. Pinch the rims, push to roll, grow your light trail. Fully hands-first, no controllers.

**Track:** Gaming
**Division:** New Experience (built from scratch on November 18, 2026)
**Build:** [https://YOUR-GITHUB-USERNAME.github.io/rim-rush/] (open it in the Meta Quest Browser and tap Enter XR)
**Video:** [YouTube/Vimeo link, public, under 3 minutes]

## Description (~450 words)

### Inspiration
Most VR games treat a wheelchair as a background prop, or don't think about it at all. We wanted to make the wheelchair the hero: fast, skilled, and fun. We also wanted a game that people can play seated, in a small space, with only their hands. Pushing a wheelchair rim is already a hand motion, so we built a game around it.

### What it does
Rim Rush puts a small neon arena on your real table using mixed reality passthrough. You steer a tiny wheelchair racer around it. Collect glowing orbs to grow a light trail behind you, like Snake, and avoid the walls, the cones, and your own trail.

- **Two-rim mode:** two large rims float in front of you at chest height, where hand tracking is most reliable. Pinch a rim and push your hand forward to roll that wheel. Push one side harder to turn. Hold a pinched rim still to brake. Pull back to reverse.
- **One-hand mode:** hold a pinch for 2 seconds on the start screen. Your pinched hand then works like a joystick (forward to drive, sideways to turn), so players with one hand or limited mobility can play.
- **Daily arena:** the cone layout changes every day and is the same for everyone that day. Your best score for today and your all-time best are saved, so there's a reason to come back tomorrow.
- **Quick sessions:** a run takes 1 to 3 minutes. It starts with one gesture, pauses when the headset loses focus, and plays entirely within a two-foot radius while seated.

### How we built it
- Meta's Immersive Web SDK (IWSDK) with WebXR immersive-ar, using passthrough and hand tracking
- Pinch detection from the WebXR hand joints (thumb tip and index tip distance, with hysteresis) plus the platform's select events as a backup
- Differential-drive physics, like a real wheelchair: each rim drives its own wheel, which gives natural coasting, braking and turning
- All art is procedural (no downloaded models), and the sound effects are synthesized live with WebAudio
- Tested in the IWER emulator with scripted hand input, and on a Meta Quest [delete "and on a Meta Quest" if you didn't test on a headset]

### Challenges
Hands resting near your lap fall outside the hand-tracking area, so real-height rims would lose tracking. We raised the rims to chest height and made pushing work from anywhere while you pinch.

### What's next
Gaze steering for Meta VR Glasses, surface detection so the arena snaps to your actual table, ghost replays of your best run, an online daily leaderboard, and playtests with wheelchair users to tune the feel.

## Hand interactions (optional field)
Every interaction is a pinch: pinch both hands to start, pinch and push to roll, hold still to brake, and hold one pinch for one-hand mode. You never need a controller. We're excited that VR can turn a real-world skill, pushing a wheelchair, into a game mechanic that anyone can learn in seconds.

## Video plan (under 3 minutes, best part first)
1. 0:00–0:10: gameplay. Pinch, push, and the chair zooms off and grabs an orb.
2. 0:10–0:40: show the two-rim controls, turning by pushing one rim, and braking.
3. 0:40–1:10: the trail grows, a close call, then a crash and the score screen.
4. 1:10–1:30: one-hand mode.
5. 1:30–1:50: the daily arena and best scores.
6. End card: "Rim Rush. Hands-first. Seated. For everyone."
