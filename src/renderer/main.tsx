import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './app.css';

const container = document.getElementById('root');
if (!container) {
	throw new Error('#root is missing from index.html');
}

createRoot(container).render(
	<StrictMode>
		{/* Rendered here rather than inside a screen: every screen would need it,
		    and a window you cannot drag is not a per-screen problem. */}
		<div className="titlebar-drag" />
		<App />
	</StrictMode>
);
