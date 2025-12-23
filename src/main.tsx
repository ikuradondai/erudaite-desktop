import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import Popup from './Popup.tsx'

const isPopup = window.location.hash.startsWith('#/popup')

createRoot(document.getElementById('root')!).render(isPopup ? <Popup /> : <App />)
