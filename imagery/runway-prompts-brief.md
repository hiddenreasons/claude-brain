Write image-to-video prompts for Runway, one per attached image: claude-brain.png (the amber one) and mac-brain.png (the blue one). Each clip is 10 seconds, square, and will play as a seamless idle loop behind a live dashboard. Lightning between the two brains is added later in code, so the clips must not contain any.

The same prompt will be used with two models, so keep it model-neutral:
- Runway Gen-4.5, image to video (first frame = the image).
- Kling 2.6 Pro, with the same image as the start frame and the end frame.

Rules for both brains:
- Camera fully locked: no zoom, pan, orbit, push-in, shake or focus change.
- The brain keeps exactly the same size, shape and position for the whole clip.
- Only slow, subtle, hypnotic motion: the core brightens and dims gently about every 3 to 4 seconds, a soft breathing glow, fine shimmer across the surface.
- Background stays pure black the whole time. No new objects, sparks flying off, lightning, flashes, lens flares, smoke, text or particles leaving the frame.
- The final frame should match the first frame in brightness and shape, so it loops.

Claude (amber sphere): the fractured amber shards drift very slowly clockwise around the core; the sweeping gold arc glides slowly around the sphere; the white-gold core swirls gently like a slow vortex.

MAC (blue crystal core): the crystal plates stay almost still, with a slow ripple of light travelling along their edges; the cyan filaments pulse outward from the center like a slow heartbeat; the surrounding specks drift slowly.

Write each prompt the way Runway's own guide recommends for image to video: describe only the motion (the image already shows the subject), plainly and specifically, with the camera instruction first. Keep each under 80 words.

Reply with exactly this, and nothing else:

CLAUDE:
<prompt>

MAC:
<prompt>

Then save the same text in the current folder as runway-prompts.md. Don't write any other file.
