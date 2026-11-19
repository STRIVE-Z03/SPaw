(function () {
  'use strict';
  const items = [
    {route:'home', icon:'home', label:'首页'},
    {route:'library', icon:'library', label:'教材'},
    {route:'arena', icon:'flag', label:'竞技场'},
    {route:'dictation', icon:'headphones', label:'听写'}
  ];
  const slots = [0, 1, 3, 4];
  let app, current;

  function selected(route) {
    if (['reader','practice'].includes(route[0])) return 1;
    return items.findIndex(item => item.route === route[0]);
  }
  function render(route, ico) {
    const active=selected(route);
    const tab=(item,index)=>`<button type="button" class="liquid-tab${index===active?' is-active':''}" data-liquid-tab="${index}" aria-label="${item.label}" ${index===active?'aria-current="page"':''}>${ico(item.icon)}<span>${item.label}</span></button>`;
    return `<div class="liquid-navigation" data-liquid-root><nav class="liquid-dock" aria-label="学习快捷导航"><div class="liquid-base"></div><div class="liquid-lens" aria-hidden="true"><canvas class="liquid-gl-canvas"></canvas></div><div class="liquid-tabs">${tab(items[0],0)}${tab(items[1],1)}<button type="button" class="liquid-plus" aria-label="打开功能菜单" aria-haspopup="dialog" data-liquid-plus>${ico('plus')}</button>${tab(items[2],2)}${tab(items[3],3)}</div></nav></div>`;
  }

  // The optical layer samples a local texture of these navigation controls.
  // It does not capture the user's page or use external image services.
  function makeRefraction(canvas, dock, tabs, plus, onReady) {
    let gl;
    try { gl=canvas.getContext('webgl',{alpha:true,antialias:true,premultipliedAlpha:true}); } catch (_) { return null; }
    if(!gl) return null;
    const vertex='attribute vec2 p;varying vec2 uv;void main(){uv=p*.5+.5;gl_Position=vec4(p,0.,1.);}';
    const fragment=`precision mediump float;
      varying vec2 uv;uniform sampler2D controls;uniform vec2 dockSize;uniform vec2 lensSize;
      uniform float centerX;uniform float amount;uniform float ready;uniform float drift;
      void main(){
        float aspect=lensSize.x/lensSize.y;
        vec2 p=(uv-.5)*vec2(aspect,1.0);
        float halfLine=max(0.0,(aspect-1.0)*.5);
        vec2 normal=vec2(p.x-clamp(p.x,-halfLine,halfLine),p.y)*2.0;
        float radius=length(normal);if(radius>1.0)discard;
        float edge=pow(radius,4.0);float mask=1.0-smoothstep(.975,1.0,radius);
        vec2 local=(uv-.5)*lensSize;
        vec2 bent=local*(1.0-amount*.10)-normal*edge*(1.1+amount*4.5);
        vec2 lookup=(vec2(centerX,dockSize.y*.5)+bent)/dockSize;
        vec2 dispersion=normal*edge*(.16+amount*.32)/dockSize;
        vec4 sample=texture2D(controls,lookup);
        sample.r=texture2D(controls,lookup+dispersion).r;
        sample.b=texture2D(controls,lookup-dispersion).b;
        sample*=ready;
        float glint=exp(-pow((uv.y-.94)*26.0,2.0))*exp(-pow((uv.x-.33-drift)*2.5,2.0));
        float rim=smoothstep(.88,.985,radius)*(.10+amount*.13);
        float highlight=clamp(glint*(.08+amount*.20)+rim,0.0,.35);
        vec3 rgb=sample.rgb*sample.a+vec3(1.0)*highlight*(1.0-sample.a);
        float alpha=sample.a+highlight*(1.0-sample.a);
        gl_FragColor=vec4(rgb*mask,alpha*mask);
      }`;
    function compile(type, source) {
      const shader=gl.createShader(type);gl.shaderSource(shader,source);gl.compileShader(shader);
      if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)){gl.deleteShader(shader);return null;}
      return shader;
    }
    const vs=compile(gl.VERTEX_SHADER,vertex),fs=compile(gl.FRAGMENT_SHADER,fragment);
    if(!vs||!fs){if(vs)gl.deleteShader(vs);if(fs)gl.deleteShader(fs);return null;}
    const program=gl.createProgram();gl.attachShader(program,vs);gl.attachShader(program,fs);gl.linkProgram(program);
    if(!gl.getProgramParameter(program,gl.LINK_STATUS)){gl.deleteProgram(program);gl.deleteShader(vs);gl.deleteShader(fs);return null;}
    const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);
    gl.useProgram(program);const position=gl.getAttribLocation(program,'p');gl.enableVertexAttribArray(position);gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);
    const texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,texture);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array([0,0,0,0]));
    const uniforms=Object.fromEntries(['controls','dockSize','lensSize','centerX','amount','ready','drift'].map(name=>[name,gl.getUniformLocation(program,name)]));
    const source=document.createElement('canvas'),context=source.getContext('2d');
    let disposed=false,unavailable=false,icons=null,dirty=true,textureWidth=0,textureHeight=0;
    const contextLost=event=>{
      if(disposed)return;
      event.preventDefault();unavailable=true;icons=null;dock.classList.remove('has-refraction');
      delete canvas.dataset.renderer;delete canvas.dataset.effect;onReady();
    };
    canvas.addEventListener('webglcontextlost',contextLost);
    function imageFor(svg, colour) {
      const clone=svg.cloneNode(true);clone.setAttribute('xmlns','http://www.w3.org/2000/svg');clone.setAttribute('width','24');clone.setAttribute('height','24');clone.removeAttribute('class');clone.setAttribute('fill','none');clone.setAttribute('stroke',colour);clone.setAttribute('stroke-width','2.2');clone.setAttribute('stroke-linecap','round');clone.setAttribute('stroke-linejoin','round');
      const image=new Image();
      return new Promise((resolve,reject)=>{image.onload=()=>resolve(image);image.onerror=reject;image.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(new XMLSerializer().serializeToString(clone));});
    }
    Promise.all(tabs.map(tab=>Promise.all([imageFor(tab.querySelector('svg'),'#171b1d'),imageFor(tab.querySelector('svg'),'#5ba4d6')])).concat([imageFor(plus.querySelector('svg'),'#245e88')])).then(async values=>{
      if(document.fonts?.ready)await document.fonts.ready;
      if(disposed||unavailable)return;icons=values;dirty=true;dock.classList.add('has-refraction');canvas.dataset.renderer='webgl';canvas.dataset.effect='control-refraction';onReady();
    }).catch(()=>{});
    function updateTexture() {
      if(!icons||disposed)return;
      const ratio=Math.min(3,Math.max(2,window.devicePixelRatio||1)),rect=dock.getBoundingClientRect();
      if(!dirty&&textureWidth===rect.width&&textureHeight===rect.height)return;
      textureWidth=rect.width;textureHeight=rect.height;source.width=Math.max(1,Math.round(rect.width*ratio));source.height=Math.max(1,Math.round(rect.height*ratio));context.setTransform(ratio,0,0,ratio,0,0);context.clearRect(0,0,rect.width,rect.height);
      tabs.forEach((tab,index)=>{
        const icon=tab.querySelector('svg'),label=tab.querySelector('span'),r=icon.getBoundingClientRect(),t=label.getBoundingClientRect(),style=getComputedStyle(label);
        const lit=tab.classList.contains('is-active')||tab.classList.contains('is-hint');context.drawImage(icons[index][lit?1:0],r.left-rect.left,r.top-rect.top,r.width,r.height);
        context.fillStyle=lit?'#2e78ab':'#171b1d';context.font=`${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;context.textAlign='center';context.textBaseline='middle';context.fillText(label.textContent,(t.left+t.right)/2-rect.left,(t.top+t.bottom)/2-rect.top);
      });
      const r=plus.getBoundingClientRect(),x=r.left-rect.left,y=r.top-rect.top;
      const fill=context.createLinearGradient(x,y,x+r.width,y+r.height);fill.addColorStop(0,'#c9e5f8');fill.addColorStop(1,'#8dc3e9');context.fillStyle=fill;context.beginPath();context.roundRect(x,y,r.width,r.height,r.height/2);context.fill();
      const icon=plus.querySelector('svg').getBoundingClientRect();context.drawImage(icons[items.length],icon.left-rect.left,icon.top-rect.top,icon.width,icon.height);
      gl.bindTexture(gl.TEXTURE_2D,texture);gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,source);dirty=false;
    }
    return {
      get ready(){return !!icons;},
      invalidate(){dirty=true;},
      draw({speed,center,amount}) {
        if(disposed||unavailable)return;updateTexture();
        const ratio=Math.min(3,Math.max(2,window.devicePixelRatio||1)),width=Math.max(1,Math.round(canvas.clientWidth*ratio)),height=Math.max(1,Math.round(canvas.clientHeight*ratio));
        if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;gl.viewport(0,0,width,height);}
        gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);gl.uniform1i(uniforms.controls,0);gl.uniform2f(uniforms.dockSize,dock.clientWidth,dock.clientHeight);gl.uniform2f(uniforms.lensSize,canvas.clientWidth,canvas.clientHeight);gl.uniform1f(uniforms.centerX,center);gl.uniform1f(uniforms.amount,amount);gl.uniform1f(uniforms.ready,icons?1:0);gl.uniform1f(uniforms.drift,Math.max(-.12,Math.min(.12,speed*.01)));gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
      },
      destroy(){disposed=true;canvas.removeEventListener('webglcontextlost',contextLost);gl.deleteTexture(texture);gl.deleteBuffer(buffer);gl.deleteProgram(program);gl.deleteShader(vs);gl.deleteShader(fs);gl.getExtension('WEBGL_lose_context')?.loseContext();}
    };
  }

  function mount() {
    current?.destroy();current=null;
    const root=document.querySelector('[data-liquid-root]');if(!root)return;
    const dock=root.querySelector('.liquid-dock'),lens=root.querySelector('.liquid-lens'),tabStrip=root.querySelector('.liquid-tabs'),tabs=[...root.querySelectorAll('[data-liquid-tab]')],plus=root.querySelector('[data-liquid-plus]');
    const reduced=window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches||false;
    const initial=selected(app.route());let active=Math.max(0,initial),x=0,velocity=0,scale=1,scaleVelocity=0;
    let raf=0,timer=0,navigateTimer=0,pointer=null,holding=false,lastX=0,downX=0,downY=0,disposed=false,lit=-1,optics=null,lastFrame=0;
    if(initial<0)lens.style.opacity='0';
    const box=()=>dock.getBoundingClientRect(),step=()=>box().width/5,center=index=>step()*(slots[index]+.5);
    const indexAt=clientX=>{const relative=clientX-box().left;let nearest=active,distance=Infinity;for(let i=0;i<items.length;i++){const d=Math.abs(relative-center(i));if(d<distance){distance=d;nearest=i;}}return nearest;};
    function draw(time=performance.now()) {
      if(disposed)return;
      const dt=lastFrame?Math.max(.4,Math.min(1.5,(time-lastFrame)/16.667)):1;lastFrame=time;
      const width=Math.max(0,step()+2),desired=holding?Math.max(center(0),Math.min(center(items.length-1),lastX-box().left)):center(active),targetScale=holding?1.36:1;
      if(reduced){x=desired;velocity=0;scale=1;scaleVelocity=0;}
      else{velocity=(velocity+(desired-x)*.20*dt)*Math.pow(.72,dt);x+=velocity*dt;scaleVelocity=(scaleVelocity+(targetScale-scale)*.16*dt)*Math.pow(.72,dt);scale+=scaleVelocity*dt;}
      const stretch=reduced?0:Math.min(.12,Math.abs(velocity)*.008),sx=scale*(1+stretch),sy=scale*(1-stretch*.48);
      lens.style.setProperty('--liquid-width',width+'px');lens.style.setProperty('--liquid-x',(x-width/2)+'px');lens.style.setProperty('--liquid-scale-x',String(sx));lens.style.setProperty('--liquid-scale-y',String(sy));
      optics?.draw({speed:velocity,center:x,amount:Math.max(0,Math.min(1,(scale-1)/.36))});
      if(optics?.ready&&lens.style.opacity!=='0'){
        const left=Math.max(0,x-width*sx/2+1),right=Math.min(dock.clientWidth,x+width*sx/2-1);
        const mask=`linear-gradient(90deg,#000 0px,#000 ${left}px,transparent ${left+.5}px,transparent ${right-.5}px,#000 ${right}px,#000 100%)`;
        tabStrip.style.maskImage=mask;tabStrip.style.webkitMaskImage=mask;
      }else{tabStrip.style.maskImage='';tabStrip.style.webkitMaskImage='';}
      if(!reduced&&(Math.abs(desired-x)>.04||Math.abs(velocity)>.04||Math.abs(targetScale-scale)>.002||Math.abs(scaleVelocity)>.002))raf=requestAnimationFrame(draw);else{raf=0;lastFrame=0;}
    }
    function animate(){if(!raf)raf=requestAnimationFrame(draw);}
    try{optics=makeRefraction(root.querySelector('canvas'),dock,tabs,plus,animate);}catch(_){optics=null;}
    function hint(index){if(lit===index)return;lit=index;tabs.forEach((tab,i)=>tab.classList.toggle('is-hint',i===index));optics?.invalidate();}
    function show(index){lens.style.opacity='1';active=index;tabs.forEach((tab,i)=>{tab.classList.toggle('is-active',i===index);tab.classList.remove('is-hint');if(i===index)tab.setAttribute('aria-current','page');else tab.removeAttribute('aria-current');});lit=-1;optics?.invalidate();animate();}
    function navigate(index){show(index);clearTimeout(navigateTimer);navigateTimer=setTimeout(()=>{if(!disposed)app.go(items[index].route);},reduced?0:240);}
    function beginHold(){if(pointer===null)return;holding=true;lens.style.opacity='1';root.classList.add('is-dragging');animate();}
    dock.addEventListener('pointerdown',event=>{
      if(event.target.closest('[data-liquid-plus]')||event.isPrimary===false||(event.pointerType==='mouse'&&event.button!==0)||pointer!==null)return;
      clearTimeout(timer);clearTimeout(navigateTimer);pointer=event.pointerId;downX=lastX=event.clientX;downY=event.clientY;holding=false;try{dock.setPointerCapture(pointer);}catch(_){}timer=setTimeout(beginHold,180);
    });
    dock.addEventListener('pointermove',event=>{if(event.pointerId!==pointer)return;lastX=event.clientX;if(!holding&&Math.abs(event.clientX-downX)>8&&Math.abs(event.clientX-downX)>Math.abs(event.clientY-downY))beginHold();if(holding){hint(indexAt(lastX));animate();}else if(Math.abs(event.clientY-downY)>16)clearTimeout(timer);});
    function release(event,cancelled){if(event.pointerId!==pointer)return;clearTimeout(timer);const wasHolding=holding;holding=false;root.classList.remove('is-dragging');const index=indexAt(event.clientX);pointer=null;if(!cancelled&&(wasHolding||(Math.abs(event.clientX-downX)<14&&Math.abs(event.clientY-downY)<14)))navigate(index);else{hint(-1);animate();}try{dock.releasePointerCapture(event.pointerId);}catch(_){}}
    dock.addEventListener('pointerup',event=>release(event,false));dock.addEventListener('pointercancel',event=>release(event,true));
    dock.addEventListener('lostpointercapture',()=>{if(pointer!==null){clearTimeout(timer);pointer=null;holding=false;root.classList.remove('is-dragging');hint(-1);animate();}});
    dock.addEventListener('contextmenu',event=>event.preventDefault());dock.addEventListener('click',event=>{const tab=event.target.closest('[data-liquid-tab]');if(tab&&event.detail===0){event.preventDefault();navigate(Number(tab.dataset.liquidTab));}});
    plus.addEventListener('click',()=>app.openMenu());
    const resize=()=>{x=center(active);velocity=0;optics?.invalidate();animate();};
    const focus=()=>{const e=document.activeElement;root.classList.toggle('is-keyboard-open',!!e?.matches?.('input,textarea,select,[contenteditable="true"]'));};
    document.addEventListener('focusin',focus);document.addEventListener('focusout',focus);window.addEventListener('resize',resize);
    x=center(active);draw();focus();
    current={destroy(){disposed=true;cancelAnimationFrame(raf);clearTimeout(timer);clearTimeout(navigateTimer);optics?.destroy();document.removeEventListener('focusin',focus);document.removeEventListener('focusout',focus);window.removeEventListener('resize',resize);}};
  }
  window.BX_LIQUID_NAV={connect(value){app=value;},render,mount,destroy(){current?.destroy();current=null;}};
})();
