import { createRoot } from 'react-dom/client';
import './index.css';
import { VideoWindow } from './components/VideoWindow';

document.body.classList.add('app-body');
createRoot(document.getElementById('root')!).render(<VideoWindow />);
