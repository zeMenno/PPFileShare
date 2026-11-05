import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';
import { registerServiceWorker } from './lib/engine/sinks';

registerServiceWorker();

mount(App, { target: document.getElementById('app')! });
