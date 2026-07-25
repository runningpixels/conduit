import { Prism } from 'prism-react-renderer';

(globalThis as { Prism?: typeof Prism }).Prism = Prism;

export { Prism };
