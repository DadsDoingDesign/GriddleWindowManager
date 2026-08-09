// Overlay entry point. Deliberately does NOT import app.css: the shared
// stylesheet paints an opaque page background, and this window must stay
// fully transparent (Overlay.svelte carries its own minimal global styles).
import { mount } from 'svelte'
import Overlay from './Overlay.svelte'

const app = mount(Overlay, {
  target: document.getElementById('app')!,
})

export default app
