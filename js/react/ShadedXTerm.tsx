import * as React from "react";
import { WebglAddon } from "xterm-addon-webgl";
import { WebLinksAddon } from "xterm-addon-web-links";
import { FitAddon } from "xterm-addon-fit";
import * as THREE from "three";
import * as PP from "postprocessing";

import { options } from "../util/XTermOptions";
import * as KEYS from "../util/keycodes";
import "xterm/css/xterm.css";
import glitchShader from "../../shaders/glitch.glsl";

// We are using these as types.
// eslint-disable-next-line no-unused-vars
import { Terminal } from "xterm";
import { sleep } from "../util/async";

const SCALE_FACTOR_LOW: number = 0.01;
const SCALE_FACTOR_MID: number = 0.06;
const SCALE_FACTOR_HIGH: number = 0.3;

interface IProps {
  /**
   * Class name to add to the terminal container.
   */
  className?: string;

  /**
   * Adds an event listener for when a data event fires. This happens for
   * example when the user types or pastes into the terminal. The event value
   * is whatever `string` results, in a typical setup, this should be passed
   * on to the backing pty.
   */
  onData?(data: string): void;
}

type XTermCanvases = {
  screen: HTMLCanvasElement;
  cursor: HTMLCanvasElement;
  link: HTMLCanvasElement;
}

type XTermTextures = {
  screen: THREE.CanvasTexture;
  cursor: THREE.CanvasTexture;
  link: THREE.CanvasTexture;
}

const LAYER_ZINDEX = {
  screen: 0,
  cursor: 1,
  link: 2
}

export default class ShadedXTerm extends React.Component<IProps> {
  /**
   * The ref for the containing element.
   */
  terminalRef: React.RefObject<HTMLDivElement>;

  /**
   * XTerm.js Terminal object.
   */
  terminal!: Terminal; // This is assigned in the setupTerminal() which is called from the constructor

  // For shader
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  canvas: HTMLCanvasElement;
  mesh: THREE.Mesh;
  camera: THREE.Camera;
  composer: any;
  lastRenderTime: number;
  clock: THREE.Clock;
  animationId: any;
  passes: any;
  timeUniforms: any;
  scaleFactorUniforms: any;
  scaleFactor: number;

  // Layers
  xtermCanvases: XTermCanvases;
  xtermTextures: XTermTextures;

  constructor(props: IProps) {
    super(props);
    this.terminalRef = React.createRef();
    this.scaleFactor = SCALE_FACTOR_LOW;

    this.setupTerminal();
  }

  setupTerminal() {
    // Setup the XTerm terminal.
    this.terminal = new Terminal(options);

    // Create Listeners
    this.terminal.onData(this.onData);
  }

  addTextures = () => {
    const xTermScreen = this.terminal.element;
    if (!xTermScreen) return;

    // Get canvas textures
    const [link, cursor, screen] = Array.from(xTermScreen.querySelectorAll("canvas"));
    this.xtermCanvases = {link, cursor, screen};
    this.xtermTextures = {
      link: new THREE.CanvasTexture(link),
      cursor: new THREE.CanvasTexture(cursor),
      screen: new THREE.CanvasTexture(screen)
    }

    for (const [key, texture] of Object.entries(this.xtermTextures)) {
      texture.minFilter = THREE.LinearFilter;
      const geometry = new THREE.PlaneGeometry(1, 1);
      const material = new THREE.MeshBasicMaterial({
        transparent: true,
        map: texture,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.z = LAYER_ZINDEX[key];
      this.scene.add(mesh);
    }
  };

  textureRefresher = (...textures: THREE.CanvasTexture[]) => () => {
    for (let texture of textures) {
      texture.needsUpdate = true;
    }
  }

  animate = () => {
    for (let i = 0; i < this.timeUniforms.length; i++) {
      this.timeUniforms[i].value = this.clock.getElapsedTime() + 1;
    }

    this.composer.render(this.clock.getDelta());
    this.lastRenderTime = performance.now();
  };

  animateLoop = () => {
    this.animationId = window.requestAnimationFrame(this.animateLoop);
    const now = performance.now();
    if (now - this.lastRenderTime < 1000 / 30) {
      return;
    }

    this.animate();
  };

  startAnimate = () => {
    const fms = 1000 / 30;
    this.lastRenderTime = fms;

    this.timeUniforms = this.passes
      .filter((pass: any) => {
        return (
          pass.getFullscreenMaterial() &&
          pass.getFullscreenMaterial().uniforms.time !== undefined
        );
      })
      .map((pass: any) => {
        return pass.getFullscreenMaterial().uniforms.time;
      });

    this.scaleFactorUniforms = this.passes
      .filter((pass: any) => {
        return (
          pass.getFullscreenMaterial() &&
          pass.getFullscreenMaterial().uniforms.e0ScaleFactor !== undefined
        );
      })
      .map((pass: any) => {
        return pass.getFullscreenMaterial().uniforms.e0ScaleFactor;
      });

    this.clock.start();
    this.animateLoop();
    this.terminal.onRender(this.textureRefresher(this.xtermTextures.screen, this.xtermTextures.cursor));
    this.terminal.onSelectionChange(this.textureRefresher(this.xtermTextures.link));

    if (!this.terminal.element) return;
    this.terminal.element.addEventListener("mouseup", this.textureRefresher(this.xtermTextures.link));
    this.terminal.element.addEventListener("mousedown", this.textureRefresher(this.xtermTextures.link));
    this.terminal.element.addEventListener("drag", this.textureRefresher(this.xtermTextures.link));
  };

  webgl_init = () => {
    // Setup camera and scene
    this.clock = new THREE.Clock(false);
    this.camera = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 1, 1000);
    this.camera.position.z = 400;
    this.scene = new THREE.Scene();
    this.addTextures();

    // Setup renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    if (!this.terminal.element) return;
    this.renderer.setSize(
      this.terminal.element.clientWidth,
      this.terminal.element.clientHeight
    );
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.domElement.id = "webgl-renderer";
    document.body.appendChild(this.renderer.domElement);

    // Setup composer
    this.composer = new PP.EffectComposer(this.renderer);
    this.passes = [
      new PP.RenderPass(this.scene, this.camera),
      new PP.EffectPass(
        null,
        new PP.Effect("filmShader", glitchShader, {
          blendFunction: PP.BlendFunction.NORMAL,
          uniforms: new Map(
            Object.entries({
              scaleFactor: new THREE.Uniform(SCALE_FACTOR_LOW),
            })
          ),
        })
      ),
    ];
    for (const pass of this.passes) {
      this.composer.addPass(pass);
    }

    this.startAnimate();
  };

  setScaleFactor = (scaleFactor: number) => {
    for (let i = 0; i < this.scaleFactorUniforms.length; i++) {
      this.scaleFactorUniforms[i].value = scaleFactor;
    }
  };

  lerp = async (start: number, end: number, n: number, ms: number) => {
    const delta = (end - start) / n;
    let value = start;
    for (let i = 0; i < n; ++i) {
      this.setScaleFactor(value);
      value += delta;
      await sleep(ms);
    }
    this.setScaleFactor(end);
  };

  spikeGlitch = async () => {
    await this.lerp(SCALE_FACTOR_LOW, SCALE_FACTOR_MID, 4, 25);
    return this.lerp(SCALE_FACTOR_MID, SCALE_FACTOR_LOW, 4, 25);
  };

  fadeIn = async (n: number) => {
    return this.lerp(SCALE_FACTOR_HIGH, SCALE_FACTOR_LOW, n, 50);
  };

  fadeOut = async (n: number) => {
    return this.lerp(SCALE_FACTOR_LOW, SCALE_FACTOR_HIGH, n, 50);
  };

  onData = (data: string) => {
    const code: Number = data.charCodeAt(0);
    if (code === KEYS.ENTER || code == KEYS.TAB) {
      this.spikeGlitch();
    }

    if (this.props.onData) this.props.onData(data);
  };

  componentDidMount = () => {
    if (this.terminalRef.current) {
      // Creates the terminal within the container element.
      this.terminal.open(this.terminalRef.current);

      // Load addons
      const fitAddon = new FitAddon();
      this.terminal.loadAddon(fitAddon);
      fitAddon.fit();

      this.terminal.loadAddon(new WebglAddon());
      this.terminal.loadAddon(new WebLinksAddon());

      // Initialize shader
      this.webgl_init();
    }
  };

  componentWillUnmount = () => {
    // When the component unmounts dispose of the terminal and all of its listeners.
    this.terminal.dispose();
  };

  render = () => {
    return <div className={this.props.className} ref={this.terminalRef} />;
  };
}
