import { createRoot } from 'react-dom/client';
import './index.css';
import { VideoBrowser } from './components/VideoBrowser';

document.body.classList.add('app-body');
createRoot(document.getElementById('root')!).render(<VideoBrowser />);
