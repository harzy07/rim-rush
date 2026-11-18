# Rim Rush: Devpost submission draft

Replace everything in [brackets] before submitting.

**Name:** Rim Rush

**Tagline (max 140 chars):**
Sit in a neon wheelchair and push the rims with your bare hands. Grab orbs, dodge cones, and don't hit your own light trail.

**Track:** Gaming
**Division:** New Experience (built from scratch on November 18, 2026)
**Build:** [https://YOUR-GITHUB-USERNAME.github.io/rim-rush/] (open it in the Meta Quest Browser and tap Enter XR)
**Video:** [YouTube/Vimeo link, public, under 3 minutes]

## Description (~450 words)

### Inspiration
Most VR games treat a wheelchair as a background prop, or don't think about it at all. We wanted the wheelchair to be the hero: fast, skilled, and fun. And since you play seated anyway, the most natural VR locomotion for a seated player is a wheelchair. Pushing a rim is already a hand motion, so we built a game around it.

### What it does
In Rim Rush you sit in a wheelchair in a 20 × 20 m neon arena. When you look down, you see your seat, your legs, and two big wheels. You drive by pushing the rims with your hands. Collect glowing orbs to make your light trail longer, like Snake or a light cycle, and avoid the walls, the cones, and your own trail.

- **Two-rim mode:** two rims float at chest height, where hand tracking is most reliable. Pinch a rim and push your hand forward to roll that wheel. Push one side harder to turn. Hold a pinched rim still to brake. Pull back to reverse. The wheelchair coasts between pushes, like a real one.
- **One-hand mode:** hold a pinch for 2 seconds on the start screen. Your pinched hand then works like a joystick (forward to drive, sideways to turn), so players with one hand or limited mobility can play.
- **Comfort:** you're seated, the turns are gentle, and a vignette darkens the edges of your view while you move or turn. Press V to toggle it.
- **Daily arena:** the cone layout changes every day and is the same for everyone that day. Your best score for today and your all-time best are saved.
- **Quick sessions:** a run takes 1 to 3 minutes. The first orb is straight ahead so new players learn to push right away. It starts with one gesture and pauses when the headset loses focus.

### How we built it
- Meta's Immersive Web SDK (IWSDK) with WebXR immersive-vr and hand tracking
- Pinch detection from the WebXR hand joints (thumb tip and index tip distance, with hysteresis) plus the platform's select events as a backup
- Hand motion is measured in the XR-origin's local space, so your own movement through the arena never counts as a push
- Differential-drive physics, like a real wheelchair. The game rotates the play space around your head, so turning never swings your view sideways
- All art is procedural and the sound effects are synthesized live with WebAudio, so there's nothing to download
- Tested in the IWER emulator with scripted hand input [add "and on a Meta Quest" if you tested on a headset]

### Challenges
Hands resting near your lap fall outside the hand-tracking area, so real-height rims would lose tracking. We raised the grab rims to chest height and kept the real wheels at your sides, where you see them when you look down. We also tuned first-person movement for comfort with gentle turns and the vignette.

### What's next
Gaze steering for Meta VR Glasses, tricks and drift scoring, ghost replays, an online daily leaderboard, and playtests with wheelchair users to tune the feel.

## Hand interactions (optional field)
Every interaction is a pinch: pinch both hands to start, pinch and push to roll, hold still to brake, and hold one pinch for one-hand mode. You never need a controller. We're excited that VR can turn a real-world skill, pushing a wheelchair, into a game mechanic that anyone can learn in seconds.

## Video plan (under 3 minutes, best part first)
1. 0:00–0:10: first-person, push off and grab the first orb straight ahead.
2. 0:10–0:40: look down at the chair and your legs, then turn by pushing one rim.
3. 0:40–1:10: the light trail grows, a near miss around the cones, a crash, and the score screen.
4. 1:10–1:30: one-hand mode.
5. 1:30–1:50: the daily arena and best scores.
6. End card: "Rim Rush. Hands-first. Seated. For everyone."
