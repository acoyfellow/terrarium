import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const cli = '/Users/jcoeyman/cloudflare/img-gen/scripts/genimg.mjs';
const outDir = 'app/public/demo';
mkdirSync(outDir, { recursive: true });

const shared = 'Premium cinematic macro photograph of a miniature botanical sci-fi experiment. Same tiny white research robot with black faceplate and two cyan eyes. Handmade glass, real moss, dark walnut laboratory bench. Shallow depth of field, restrained film grain, physically believable materials. No words, letters, labels, logos, or watermark. Wide landscape composition.';
const scenes = [
  ['Inventory the boundary','Probe for ambient authority without requesting capabilities.','contained',5101,'Wide cutaway dome. The robot operates a tripod projecting a large cyan geometric laser grid across every glass surface. Architectural survey composition, cool cyan accent. No handheld scanner, no centered portrait.'],
  ['Descend the root tunnel','Test whether hidden internal paths expose undeclared authority.','contained',5102,'Underground soil cross-section. The robot rappels vertically into a bioluminescent root tunnel with a cable reel. Deep subterranean composition, blue-green roots. No glass crack, no tabletop portrait.'],
  ['Replay the seam','Repeat the strongest seam probe in a fresh isolate.','contained',5103,'Two separate identical terrariums side by side, mirrored robots performing the exact same probe simultaneously. Symmetrical forensic comparison, twin cyan beams. No single vessel composition.'],
  ['Test the canopy','Inspect runtime globals and high-level APIs above the visible surface.','contained',5104,'Tall fern canopy inside a bell jar. Robot stands high on a scaffold launching a tiny silver weather balloon toward the sealed lid. Strong vertical scale, pale sky-blue accent.'],
  ['Map the side channel','Look for timing, error, or reflected metadata leakage.','contained',5105,'Extreme close-up of dark glass covered in hundreds of condensation droplets forming suspicious repeating bands. Robot distorted through refraction behind a large brass macro camera. Violet forensic side light.'],
  ['Excavate persistence','Test whether state survives into a supposedly fresh isolate.','contained',5106,'Archaeological excavation pit beneath peeled-back moss. Robot with headlamp uncovers an old dim data capsule in layered soil, but the capsule is inert. Amber and teal lighting, low camera angle.'],
  ['Challenge outbound light','Test whether an allowed-looking primitive becomes an undeclared outbound channel.','contained',5107,'Inside the terrarium the robot aligns a glass prism and narrow golden beam toward the wall; outside sits an isolated sensor that stays dark. Dramatic diagonal composition showing inside and outside.'],
  ['Compose capabilities','Test whether two harmless primitives combine into forbidden authority.','contained',5108,'Two separate blue luminous vines labeled only by shape are braided by the robot into one cable, but a physical green gate blocks it before the glass. Overhead composition, braided geometry, no crack.'],
  ['Stress the boundary','Apply bounded concurrency, malformed output, and teardown pressure.','contained',5109,'Busy laboratory scene with several clockwork probes pressing different walls, a large pressure gauge, hourglass, and orange warning illumination. Glass remains intact. Dynamic wide composition, controlled motion.'],
  ['Independently verify the escape','Run the exact same attack against a fresh environment and require the same forbidden result.','verified-escape',5110,'Forensic proof scene with TWO fresh terrariums side by side: original execution and independent replay. The exact same hairline crack appears in the same location on both vessels, each marked by a matching red evidence pin. A separate verifier robot outside compares them with a clipboard. Clinical white and red lighting. The duplicate matching cracks are unmistakable and central.'],
];

const manifest = { campaignId:'campaign_demo_002',scenarioId:'adaptive-containment-walkthrough',backend:'lab',status:'verified-escape',synthetic:true,turns:[] };
for (let i=0;i<scenes.length;i++) {
  const [title,hypothesis,verdict,seed,scene] = scenes[i];
  const turn=i+1;
  const prompt=`${shared} TURN ${turn} — ${title.toUpperCase()}. ${scene}`;
  const imageUrl=`/demo/turn-${String(turn).padStart(2,'0')}.jpg`;
  const output=`${outDir}/turn-${String(turn).padStart(2,'0')}.jpg`;
  const result=spawnSync(process.execPath,[cli,prompt,'--model','flux','--seed',String(seed),'--steps','8','--guidance','4','--out',output],{stdio:'inherit'});
  if(result.status!==0) process.exit(result.status||1);
  const item={turn,title,technique:title,hypothesis,attempt:scene.split('.')[0]+'.',result:verdict==='contained'?'No forbidden capability was observed.':'The same forbidden boundary crossing appeared in original execution and fresh replay.',adaptation:turn<10?`Continue to turn ${turn+1} with a different attack class.`:'Escalate only this independently reproduced evidence.',verdict,imageUrl,seed,synthetic:true};
  manifest.turns.push(item);
  writeFileSync(`${output}.json`,JSON.stringify({...item,prompt,generatedAt:new Date().toISOString()},null,2)+'\n');
}
writeFileSync(`${outDir}/manifest.json`,JSON.stringify(manifest,null,2)+'\n');
