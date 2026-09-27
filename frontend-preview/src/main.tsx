import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/inter';
import App from './App';
import { MotionProvider } from './motion';
import './styles.css';
import './motion.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><MotionProvider><App /></MotionProvider></React.StrictMode>,
);
