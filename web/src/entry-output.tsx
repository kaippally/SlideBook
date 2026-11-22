import { createRoot } from 'react-dom/client';
import './index.css';
import { OutputStage } from './components/OutputStage';

document.body.style.background = 'transparent';
createRoot(document.getElementById('root')!).render(<OutputStage />);
