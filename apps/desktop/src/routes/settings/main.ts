import { mount } from 'svelte'
import '../../app.css'
import Settings from './Settings.svelte'

const app = mount(Settings, {
  target: document.getElementById('app')!,
})

export default app
