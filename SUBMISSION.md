# Rim Rush: Meal Run, Devpost submission draft

Replace everything in [brackets] before submitting.

**Name:** Rim Rush: Meal Run

**Tagline (max 140 chars):**
Push your wheelchair through a real-feeling home with your bare hands. Get to breakfast, lunch and dinner before your food goes cold.

**Track:** Gaming
**Division:** New Experience (built from scratch on November 18, 2026)
**Build:** [https://YOUR-GITHUB-USERNAME.github.io/rim-rush/] (open it in the Meta Quest Browser and tap Enter XR)
**Video:** [YouTube/Vimeo link, public, under 3 minutes, real gameplay footage only, no AI-generated video]
**Target launch date:** [e.g. Q2 2027 on the Meta Horizon Store, alongside the Meta VR Glasses launch]
**Testing instructions:** Open the link in the Meta Quest Browser, tap Enter XR, put controllers down so hand tracking takes over, pinch both hands to start. Desktop fallback: arrow keys + Space.

## Description (~420 words)

### Inspiration
Getting from the bedroom to the kitchen is an everyday trip for a wheelchair user, and narrow doorways, a laundry basket left out, or a pet in the way make it harder. Most VR games ignore wheelchairs. We wanted to put players in the seat and make the trip fun and a little challenging, using only their hands.

### What it does
You sit in a wheelchair in a four-room home: bedroom, living room, dining room, and kitchen. Look down and you see your legs, your shoes on the footplate, and the wheels at your sides. Your tracked hands drive the chair.

- **Push the rims:** two grab rims sit at lower-chest height, where hand tracking is most reliable. Pinch a rim and push forward to roll, push one side harder to turn, hold still to brake, and pull back to reverse. The chair coasts between pushes, and the wheels and rims turn as it rolls.
- **Three levels:**
  - **Breakfast:** from the bedroom, through the dining room, to the kitchen table.
  - **Lunch:** from the sofa to the dining table, past laundry, toys and plants on the floor.
  - **Dinner:** from the bedroom, through the living room, to the kitchen counter, with a robot vacuum and the dog moving in your path.
- **Coins and guidance:** spinning gold coins along each route add 3 seconds each, a green light beam marks the goal, and floating signs name every room.
- **Challenge:** each level has a timer. Bumping furniture stops the chair, like it would in real life, and costs 2 seconds. You earn up to 3 stars per level, and your best stars are saved.
- **Guidance and comfort:** a green arrow on the chair points to the meal and a glowing ring marks the goal. Turns are gentle, the view turns around your head, and a vignette darkens the edges of your view while you move (press V to toggle it).
- **One-hand mode:** hold a pinch for 2 seconds on a menu screen. Your pinched hand then works like a joystick, so players with one hand or limited mobility can play.

### How we built it
- Meta's Immersive Web SDK (IWSDK) with WebXR immersive-vr and hand tracking
- Pinch detection from the WebXR hand joints (thumb and index tip distance, with hysteresis) plus the platform's select events as a backup
- Hand motion is measured in the XR-origin's local space, so riding never counts as a push
- Differential-drive wheelchair physics with circle-against-box collision for walls and furniture
- All of the home, furniture, food, and chair is built from code, and sound effects are synthesized live with WebAudio, so there's nothing to download
- Tested in the IWER emulator with scripted hand input [add "and on a Meta Quest" if you tested on a headset]

### Challenges
Hands resting near your lap fall outside the hand-tracking area, so we raised the grab rims to lower-chest height and kept the real wheels at your sides. Doorways are 1.2 m wide, which is tight but fair for a 0.7 m chair.

### What's next
More homes and an apartment with ramps and elevators, gaze steering for Meta VR Glasses, ghost replays, and playtests with wheelchair users to tune the feel.

## Hand interactions (optional field)
Every interaction is a pinch: pinch both hands to start, pinch and push to roll, hold still to brake, and hold one pinch for one-hand mode. You never need a controller.

## Video plan (under 3 minutes, best part first)
1. 0:00–0:10: look down at your legs and wheels, pinch, push off.
2. 0:10–0:45: Breakfast. Turn through the bedroom doorway, follow the arrow, reach the kitchen table, earn stars.
3. 0:45–1:20: Lunch. Weave around the laundry and toys, bump a box, and the timer drops.
4. 1:20–1:50: Dinner. Dodge the robot vacuum and the dog, reach the counter, "BON APPÉTIT!"
5. 1:50–2:10: one-hand mode.
6. End card: "Rim Rush: Meal Run. Hands-first. Seated. For everyone."
