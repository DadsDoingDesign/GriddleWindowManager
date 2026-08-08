import { mount } from 'svelte'
import '../../app.css'
import Brain from './Brain.svelte'

const app = mount(Brain, {
  target: document.getElementById('app')!,
})

export default app
