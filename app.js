(() => {
  'use strict';
  const piano = document.querySelector('#piano');
  const labels = document.querySelector('#labels');
  const velocity = document.querySelector('#velocity');
  const velOut = document.querySelector('#velOut');
  const sustainBtn = document.querySelector('#sustain');
  const fullscreenBtn = document.querySelector('#fullscreen');
  const status = document.querySelector('#status');
  const about = document.querySelector('#about');
  const toneSelect = document.querySelector('#tone');
  const roomSelect = document.querySelector('#room');
  const touchSelect = document.querySelector('#touch');
  const mechanical = document.querySelector('#mechanical');
  const mechOut = document.querySelector('#mechOut');
  const resonance = document.querySelector('#resonance');
  const resOut = document.querySelector('#resOut');

  const START = 60;
  const END = 88;
  const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const WHITE_PC = new Set([0,2,4,5,7,9,11]);
  const LAYERS = Array.from({length:16}, (_,i)=>i+1);
  const BASE = 'https://raw.githubusercontent.com/sfzinstruments/SalamanderGrandPiano/master/Samples/';
  const buffers = new Map();
  const active = new Map();
  const pendingReleases = new Set();
  const pointers = new Map();
  const PRELOAD_CENTERS = [60,63,66,69,72,75,78,81,84,87];
  const TONE_PRESETS = {
    concert: {gain:.95, lowpass:17800, highshelf:0, peaking:0, release:.72},
    warm: {gain:.98, lowpass:7600, highshelf:-4, peaking:1.5, release:.82},
    bright: {gain:.92, lowpass:20000, highshelf:4, peaking:2.5, release:.68},
    mellow: {gain:1, lowpass:5600, highshelf:-6, peaking:-1.5, release:.88}
  };
  const ROOM_PRESETS = {
    dry: {mix:0, time:.2, decay:1.2},
    studio: {mix:.16, time:1.1, decay:2.2},
    hall: {mix:.28, time:2.7, decay:3.6}
  };
  let audio = null;
  let sustain = false;
  let preloaded = false;
  let nodes = null;

  function noteName(midi){
    const pc = midi % 12;
    const oct = Math.floor(midi / 12) - 1;
    return `${NOTE_NAMES[pc]}${oct}`;
  }

  function regionFor(midi){
    const centers = [21];
    for(let c=24;c<=108;c+=3) centers.push(c);
    let best=centers[0], dist=Infinity;
    for(const c of centers){
      const d=Math.abs(midi-c);
      if(d<dist){best=c;dist=d;}
    }
    return best;
  }

  function sampleURL(center, layer){
    const file = `${noteName(center)}v${layer}.flac`;
    return BASE + encodeURIComponent(file).replace(/%2F/g,'/');
  }

  function mapVelocity(v){
    const raw=Math.max(1,Math.min(127,Number(v)||88));
    const n=raw/127;
    const mode=touchSelect?.value||'normal';
    const curved=mode==='soft'?Math.pow(n,.78):mode==='firm'?Math.pow(n,1.35):n;
    return Math.max(1,Math.min(127,Math.round(curved*126+1)));
  }

  function layerFor(v){
    return LAYERS[Math.max(0,Math.min(15,Math.round((v-1)/126*15)))];
  }

  function createImpulse(seconds=1.2, decay=2.5){
    const rate=audio.sampleRate;
    const length=Math.max(1,Math.floor(rate*seconds));
    const impulse=audio.createBuffer(2,length,rate);
    for(let ch=0;ch<2;ch++){
      const data=impulse.getChannelData(ch);
      for(let i=0;i<length;i++){
        const t=i/length;
        data[i]=(Math.random()*2-1)*Math.pow(1-t,decay);
      }
    }
    return impulse;
  }

  function createNoiseBuffer(duration=.06){
    const rate=audio.sampleRate;
    const length=Math.max(1,Math.floor(rate*duration));
    const buffer=audio.createBuffer(1,length,rate);
    const data=buffer.getChannelData(0);
    for(let i=0;i<length;i++) data[i]=(Math.random()*2-1)*(1-i/length);
    return buffer;
  }

  async function ensureAudio(){
    if(!audio){
      audio=new (window.AudioContext||window.webkitAudioContext)({latencyHint:'interactive'});
      const input=audio.createGain();
      const master=audio.createGain();
      const toneLowpass=audio.createBiquadFilter(); toneLowpass.type='lowpass';
      const tonePeak=audio.createBiquadFilter(); tonePeak.type='peaking'; tonePeak.frequency.value=1900; tonePeak.Q.value=.8;
      const toneHigh=audio.createBiquadFilter(); toneHigh.type='highshelf'; toneHigh.frequency.value=4200;
      const dry=audio.createGain();
      const wetSend=audio.createGain();
      const convolver=audio.createConvolver();
      const wet=audio.createGain();
      const resonanceBus=audio.createGain();
      const resonanceFilter=audio.createBiquadFilter(); resonanceFilter.type='bandpass'; resonanceFilter.frequency.value=920; resonanceFilter.Q.value=1.1;
      const resonanceGain=audio.createGain();
      const noiseBus=audio.createGain();
      input.connect(toneLowpass);
      toneLowpass.connect(tonePeak);
      tonePeak.connect(toneHigh);
      toneHigh.connect(dry).connect(master);
      toneHigh.connect(wetSend).connect(convolver).connect(wet).connect(master);
      toneHigh.connect(resonanceBus).connect(resonanceFilter).connect(resonanceGain).connect(master);
      noiseBus.connect(master);
      master.gain.value=.92;
      master.connect(audio.destination);
      nodes={input,master,toneLowpass,tonePeak,toneHigh,dry,wetSend,convolver,wet,resonanceBus,resonanceGain,noiseBus};
      nodes.convolver.buffer=createImpulse(1.2,2.5);
      applyTone();
      applyRoom();
      applyResonance();
      applyMechanical();
    }
    if(audio.state==='suspended') await audio.resume();
  }

  function applyTone(){
    if(!nodes) return;
    const preset=TONE_PRESETS[toneSelect.value]||TONE_PRESETS.concert;
    nodes.master.gain.setTargetAtTime(preset.gain,audio.currentTime,.02);
    nodes.toneLowpass.frequency.setTargetAtTime(preset.lowpass,audio.currentTime,.03);
    nodes.toneHigh.gain.setTargetAtTime(preset.highshelf,audio.currentTime,.03);
    nodes.tonePeak.gain.setTargetAtTime(preset.peaking,audio.currentTime,.03);
  }

  function applyRoom(){
    if(!nodes||!audio) return;
    const room=ROOM_PRESETS[roomSelect.value]||ROOM_PRESETS.dry;
    nodes.wetSend.gain.setTargetAtTime(room.mix,audio.currentTime,.03);
    nodes.wet.gain.setTargetAtTime(room.mix?.8:0,audio.currentTime,.03);
    nodes.convolver.buffer=createImpulse(room.time,room.decay);
  }

  function applyResonance(){
    resOut.value=resonance.value;
    if(!nodes||!audio) return;
    const amt=(Number(resonance.value)||0)/100;
    nodes.resonanceGain.gain.setTargetAtTime(amt*.22,audio.currentTime,.03);
  }

  function applyMechanical(){ mechOut.value=mechanical.value; }

  async function loadSample(center,layer){
    const key=`${center}:${layer}`;
    if(buffers.has(key)) return buffers.get(key);
    const p=(async()=>{
      status.textContent=`Loading ${noteName(center)}…`;
      const res=await fetch(sampleURL(center,layer),{cache:'force-cache'});
      if(!res.ok) throw new Error(`Sample ${res.status}`);
      const arr=await res.arrayBuffer();
      const decoded=await audio.decodeAudioData(arr.slice(0));
      status.textContent=`Salamander · ${toneSelect.selectedOptions[0]?.textContent||'Concert'}`;
      return decoded;
    })().catch(err=>{buffers.delete(key);throw err;});
    buffers.set(key,p);
    return p;
  }

  function preloadLikelyNotes(){
    if(preloaded||!audio) return;
    preloaded=true;
    const layers=[...new Set([layerFor(mapVelocity(82)),layerFor(46),layerFor(112)])];
    Promise.allSettled(PRELOAD_CENTERS.flatMap(center=>layers.map(layer=>loadSample(center,layer)))).then(()=>{
      status.textContent=`Ready · ${toneSelect.selectedOptions[0]?.textContent||'Concert'}`;
    });
  }

  function synthFallback(midi,vel){
    const now=audio.currentTime;
    const freq=440*Math.pow(2,(midi-69)/12);
    const gain=audio.createGain();
    gain.gain.setValueAtTime(.0001,now);
    gain.gain.exponentialRampToValueAtTime(Math.max(.015,(vel/127)*.16),now+.008);
    gain.gain.exponentialRampToValueAtTime(.0001,now+1.6);
    gain.connect(nodes.input);
    const o1=audio.createOscillator(),o2=audio.createOscillator();
    o1.type='triangle';o2.type='sine';o1.frequency.value=freq;o2.frequency.value=freq*2.002;
    const g2=audio.createGain();g2.gain.value=.18;o2.connect(g2).connect(gain);o1.connect(gain);
    o1.start(now);o2.start(now);o1.stop(now+1.7);o2.stop(now+1.7);
    return {sources:[o1,o2],gain,fallback:true,vel};
  }

  function playMechanical(kind='down',amount=.18){
    if(!audio||!nodes) return;
    const amp=(Number(mechanical.value)||0)/100;
    if(amp<=0) return;
    const src=audio.createBufferSource();
    src.buffer=createNoiseBuffer(kind==='pedal'?.11:.04);
    const filter=audio.createBiquadFilter(); filter.type='bandpass'; filter.frequency.value=kind==='pedal'?600:1800; filter.Q.value=kind==='pedal'?.7:1.3;
    const gain=audio.createGain();
    const now=audio.currentTime;
    const level=amp*amount*(kind==='pedal'?1.2:1);
    gain.gain.setValueAtTime(level,now);
    gain.gain.exponentialRampToValueAtTime(.0001,now+(kind==='pedal'?.12:.045));
    src.connect(filter).connect(gain).connect(nodes.noiseBus);
    src.start(now); src.stop(now+(kind==='pedal'?.14:.05));
  }

  function addResonance(midi){
    if(!audio||!nodes) return;
    const amt=(Number(resonance.value)||0)/100;
    if(amt<=0) return;
    const now=audio.currentTime;
    const freq=440*Math.pow(2,(midi-69)/12);
    const osc=audio.createOscillator(); osc.type='sine'; osc.frequency.value=freq*2;
    const gain=audio.createGain();
    const level=.005+amt*.015+(sustain?.006:0);
    gain.gain.setValueAtTime(.0001,now);
    gain.gain.exponentialRampToValueAtTime(level,now+.03);
    gain.gain.exponentialRampToValueAtTime(.0001,now+(sustain?1.8:1.1));
    osc.connect(gain).connect(nodes.resonanceBus);
    osc.start(now); osc.stop(now+(sustain?1.9:1.2));
  }

  async function noteOn(midi,rawVel=Number(velocity.value)){
    await ensureAudio();
    preloadLikelyNotes();
    if(active.has(midi)) noteOff(midi,true);
    piano.querySelector(`[data-midi="${midi}"]`)?.classList.add('active');
    playMechanical('down',.12);
    const vel=mapVelocity(rawVel);
    const center=regionFor(midi),layer=layerFor(vel);
    try{
      const buffer=await loadSample(center,layer);
      const src=audio.createBufferSource();
      const gain=audio.createGain();
      src.buffer=buffer;
      src.playbackRate.value=Math.pow(2,(midi-center)/12);
      gain.gain.value=.25+(vel/127)*.75;
      src.connect(gain).connect(nodes.input);
      src.start(0,.004);
      active.set(midi,{sources:[src],gain,fallback:false,vel});
      addResonance(midi);
    }catch(e){
      console.warn('Using fallback synth:',e);
      status.textContent='Sample unavailable · fallback sound';
      active.set(midi,synthFallback(midi,vel));
    }
  }

  function releaseVoice(midi,immediate=false){
    const voice=active.get(midi); if(!voice) return;
    const now=audio?.currentTime||0;
    const preset=TONE_PRESETS[toneSelect.value]||TONE_PRESETS.concert;
    const releaseTime=immediate?.05:preset.release;
    try{
      if(voice.gain){
        const current=Math.max(.0001,voice.gain.gain.value||.0001);
        voice.gain.gain.cancelScheduledValues(now);
        voice.gain.gain.setValueAtTime(current,now);
        voice.gain.gain.exponentialRampToValueAtTime(.0001,now+releaseTime);
      }
      voice.sources.forEach(s=>s.stop(now+releaseTime+.05));
    }catch{}
    playMechanical('up',immediate?.04:.08);
    active.delete(midi);
    piano.querySelector(`[data-midi="${midi}"]`)?.classList.remove('active');
  }

  function noteOff(midi,immediate=false){
    piano.querySelector(`[data-midi="${midi}"]`)?.classList.remove('active');
    if(sustain&&!immediate){pendingReleases.add(midi);return;}
    pendingReleases.delete(midi);releaseVoice(midi,immediate);
  }

  function setSustain(on){
    const changed=on!==sustain;
    sustain=on;
    sustainBtn.setAttribute('aria-pressed',String(on));
    if(changed) playMechanical('pedal',on?.16:.11);
    if(!on){for(const midi of [...pendingReleases]) releaseVoice(midi);pendingReleases.clear();}
  }

  function buildKeyboard(){
    piano.innerHTML='';
    const whites=[];
    for(let m=START;m<=END;m++) if(WHITE_PC.has(m%12)) whites.push(m);
    const whiteW=100/whites.length;
    const whiteIndex=new Map();whites.forEach((m,i)=>whiteIndex.set(m,i));
    for(let m=START;m<=END;m++){
      const isWhite=WHITE_PC.has(m%12);
      const key=document.createElement('div');
      key.className=`key ${isWhite?'white':'black'}`;key.dataset.midi=m;key.setAttribute('role','button');key.setAttribute('aria-label',noteName(m));
      if(isWhite){const i=whiteIndex.get(m);key.style.left=`${i*whiteW}%`;key.style.width=`${whiteW}%`;}
      else{let prev=m-1;while(prev>=START&&!WHITE_PC.has(prev%12))prev--;const i=whiteIndex.get(prev);const bw=whiteW*.62;key.style.width=`${bw}%`;key.style.left=`${(i+1)*whiteW-bw/2}%`;}
      const lab=document.createElement('span');lab.className='label';lab.textContent=noteName(m);key.appendChild(lab);piano.appendChild(key);
    }
  }

  function midiFromPoint(x,y){
    const key=document.elementsFromPoint(x,y).find(e=>e.classList?.contains('key'));
    return key?Number(key.dataset.midi):null;
  }

  piano.addEventListener('pointerdown',async e=>{e.preventDefault();piano.setPointerCapture?.(e.pointerId);const midi=midiFromPoint(e.clientX,e.clientY);if(midi==null)return;pointers.set(e.pointerId,midi);await noteOn(midi);});
  piano.addEventListener('pointermove',async e=>{if(!pointers.has(e.pointerId))return;const old=pointers.get(e.pointerId),midi=midiFromPoint(e.clientX,e.clientY);if(midi!=null&&midi!==old){noteOff(old);pointers.set(e.pointerId,midi);await noteOn(midi);}});
  function pointerEnd(e){const m=pointers.get(e.pointerId);if(m!=null)noteOff(m);pointers.delete(e.pointerId);}
  piano.addEventListener('pointerup',pointerEnd);piano.addEventListener('pointercancel',pointerEnd);

  const keyMap={a:60,w:61,s:62,e:63,d:64,f:65,t:66,g:67,y:68,h:69,u:70,j:71,k:72,o:73,l:74,p:75,';':76};
  const down=new Set();
  window.addEventListener('keydown',e=>{const k=e.key.toLowerCase();if(k===' '){e.preventDefault();setSustain(true);return;}if(keyMap[k]&&!down.has(k)){down.add(k);noteOn(keyMap[k]);}});
  window.addEventListener('keyup',e=>{const k=e.key.toLowerCase();if(k===' '){setSustain(false);return;}if(keyMap[k]){down.delete(k);noteOff(keyMap[k]);}});

  labels.addEventListener('change',()=>piano.classList.toggle('show-labels',labels.checked));
  velocity.addEventListener('input',()=>velOut.value=velocity.value);
  sustainBtn.addEventListener('click',()=>setSustain(!sustain));
  fullscreenBtn.addEventListener('click',async()=>{try{if(!document.fullscreenElement)await document.documentElement.requestFullscreen();else await document.exitFullscreen();}catch{status.textContent='Tip: Add to Home Screen for full screen';}});
  toneSelect.addEventListener('change',()=>{if(nodes)applyTone();status.textContent=`Sound: ${toneSelect.selectedOptions[0].textContent}`;});
  roomSelect.addEventListener('change',()=>{if(nodes)applyRoom();});
  touchSelect.addEventListener('change',()=>{status.textContent=`Touch: ${touchSelect.selectedOptions[0].textContent}`;});
  resonance.addEventListener('input',applyResonance);
  mechanical.addEventListener('input',applyMechanical);
  document.querySelector('#info').addEventListener('click',()=>about.showModal());
  document.querySelector('#closeAbout').addEventListener('click',()=>about.close());

  buildKeyboard();velOut.value=velocity.value;mechOut.value=mechanical.value;resOut.value=resonance.value;
  if('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(()=>{});
})();
