import * as React from "react";
import PropTypes from "prop-types";
import { WebglAddon } from "xterm-addon-webgl";
import * as THREE from "three";
import * as PP from "postprocessing";

import * as KEYS from "../util/keycodes";
import "xterm/css/xterm.css";
import glitchShader from "../../shaders/glitch.glsl";

// We are using these as types.
// eslint-disable-next-line no-unused-vars
import { Terminal, ITerminalOptions, ITerminalAddon } from "xterm";

interface IProps {
  /**
   * Class name to add to the terminal container.
   */
  className?: string;

  /**
   * Options to initialize the terminal with.
   */
  options?: ITerminalOptions;

  /**
   * An array of XTerm addons to load along with the terminal.
   */
  addons?: Array<ITerminalAddon>;

  /**
   * Adds an event listener for when a data event fires. This happens for
   * example when the user types or pastes into the terminal. The event value
   * is whatever `string` results, in a typical setup, this should be passed
   * on to the backing pty.
   */
  onData?(data: string): void;
}

const SCALE_FACTOR_LOW: number = 0.012;
const SCALE_FACTOR_HIGH: number = 0.15;

export default class Xterm extends React.Component<IProps> {
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
  textures: any;
  lastRenderTime: number;
  clock: THREE.Clock;
  animationId: any;
  passes: any;
  timeUniforms: any;
  scaleFactorUniforms: any;
  scaleFactor: number;

  static propTypes = {
    className: PropTypes.string,
    options: PropTypes.object,
    onData: PropTypes.func,
  };

  constructor(props: IProps) {
    super(props);

    this.terminalRef = React.createRef();
    this.scaleFactor = SCALE_FACTOR_LOW;

    this.setupTerminal();
  }

  setupTerminal() {
    // Setup the XTerm terminal.
    this.terminal = new Terminal(this.props.options);

    // Create Listeners
    this.terminal.onData(this.onData);
  }

  getXTermLayers = () => {
    const xTermScreen = this.terminal.element;
    return Array.from(xTermScreen.querySelectorAll("canvas"));
  };

  getSortedXTermLayers = () => {
    const xTermLayers = this.getXTermLayers();

    const getZIndex = (element) => {
      const { zIndex } = window.getComputedStyle(element);
      return zIndex === "auto" ? 0 : Number(zIndex);
    };

    const map = new Map(xTermLayers.map((el) => [el, getZIndex(el)]));
    return xTermLayers.sort((a, b) => map.get(a) - map.get(b));
  };

  addTextures = () => {
    const xtermLayers = this.getSortedXTermLayers();
    this.textures = [];

    for (const [idx, canvas] of xtermLayers.entries()) {
      const texture = new THREE.CanvasTexture(canvas);
      this.textures.push(texture);

      texture.minFilter = THREE.LinearFilter;
      const geometry = new THREE.PlaneGeometry(1, 1);
      const material = new THREE.MeshBasicMaterial({
        transparent: true,
        map: texture,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.z = idx;
      this.scene.add(mesh);
    }
  };

  refreshTextures = () => {
    for (const texture of this.textures) {
      texture.needsUpdate = true;
    }
    this.animate();
  };

  animate = () => {
    for (let i = 0; i < this.timeUniforms.length; i++) {
      this.timeUniforms[i].value = (this.clock.getElapsedTime() % 5) + 5;
    }

    this.composer.render(this.clock.getDelta());
    this.lastRenderTime = performance.now();
  };

  animateLoop = () => {
    this.animationId = window.requestAnimationFrame(this.animateLoop);
    const now = performance.now();
    if (now - this.lastRenderTime < 1000 / 60) {
      return;
    }

    this.animate();
  };

  onData = (data: string) => {
    const code: Number = data.charCodeAt(0);
    if (code === KEYS.ENTER || code == KEYS.TAB) {
      this.scaleFactor = SCALE_FACTOR_HIGH;
      for (let i = 0; i < this.scaleFactorUniforms.length; i++) {
        console.log("Setting scale factor", this.scaleFactor);
        this.scaleFactorUniforms[i].value = this.scaleFactor;
      }
      setTimeout(() => {
        this.scaleFactor = SCALE_FACTOR_LOW;
        for (let i = 0; i < this.scaleFactorUniforms.length; i++) {
          this.scaleFactorUniforms[i].value = this.scaleFactor;
        }
      }, 250);
    }
    this.props.onData(data);
  };

  startAnimate = () => {
    const fps = 1000 / 60;
    this.lastRenderTime = fps;
    for (const pass of this.passes) {
      console.log(
        pass.getFullscreenMaterial() && pass.getFullscreenMaterial().uniforms
      );
    }
    this.timeUniforms = this.passes
      .filter((pass) => {
        return (
          pass.getFullscreenMaterial() &&
          pass.getFullscreenMaterial().uniforms.time !== undefined
        );
      })
      .map((pass) => {
        return pass.getFullscreenMaterial().uniforms.time;
      });

    this.scaleFactorUniforms = this.passes
      .filter((pass) => {
        return (
          pass.getFullscreenMaterial() &&
          pass.getFullscreenMaterial().uniforms.e0ScaleFactor !== undefined
        );
      })
      .map((pass) => {
        console.log({ scaleUniformPass: pass });
        return pass.getFullscreenMaterial().uniforms.e0ScaleFactor;
      });

    this.clock.start();
    this.animateLoop();
    this.terminal.onRender(this.refreshTextures);
    this.terminal.onCursorMove(this.refreshTextures);
    this.terminal.onSelectionChange(this.refreshTextures);
    this.terminal.element.addEventListener("mouseup", this.refreshTextures);
    this.terminal.element.addEventListener("mousedown", this.refreshTextures);
    this.terminal.element.addEventListener("drag", this.refreshTextures);
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
              scaleFactor: new THREE.Uniform(this.scaleFactor),
            })
          ),
        })
      ),
    ];
    for (const pass of this.passes) {
      this.composer.addPass(pass);
      if (pass.getFullscreenMaterial()) {
        console.log({ uniform: pass.getFullscreenMaterial().uniforms });
      }
    }

    this.startAnimate();
  };

  componentDidMount = () => {
    if (this.terminalRef.current) {
      // Creates the terminal within the container element.
      this.terminal.open(this.terminalRef.current);
      this.terminal.loadAddon(new WebglAddon());

      this.webgl_init();
    }
  };

  componentWillUnmount = () => {
    // When the component unmounts dispose of the terminal and all of its listeners.
    this.terminal.dispose();
  };

  render() {
    return <div className={this.props.className} ref={this.terminalRef} />;
  }
}