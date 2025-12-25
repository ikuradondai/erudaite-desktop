import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import Popup from './Popup.tsx'
import OcrOverlay from './OcrOverlay.tsx'

const isPopup = window.location.hash.startsWith('#/popup')
const isOcrOverlay = window.location.hash.startsWith('#/ocr-overlay')
if (isPopup) {
  document.documentElement.classList.add('popup')
  document.body.classList.add('popup')
}

createRoot(document.getElementById('root')!).render(isPopup ? <Popup /> : isOcrOverlay ? <OcrOverlay /> : <App />)
