/// Side-effect imports that extend prism-react-renderer's bundled Prism instance.
/// Must load after prismGlobal.ts assigns globalThis.Prism.
import './prismGlobal';

import 'prismjs/components/prism-python';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-java';
import 'prismjs/components/prism-csharp';
import 'prismjs/components/prism-ruby';
import 'prismjs/components/prism-php';
import 'prismjs/components/prism-sql';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-css';
import 'prismjs/components/prism-scss';
import 'prismjs/components/prism-less';
import 'prismjs/components/prism-toml';
import 'prismjs/components/prism-lua';
import 'prismjs/components/prism-scala';
import 'prismjs/components/prism-r';
import 'prismjs/components/prism-powershell';
import 'prismjs/components/prism-docker';
import 'prismjs/components/prism-ini';
import 'prismjs/components/prism-diff';
// Languages `CODE_LANG` already accepts as fence labels but whose grammars were
// never loaded, so they silently fell back to plain text. That went unnoticed
// because highlighting produced no colour at all until the `token` base class
// was fixed — these are the labels that would still fail afterwards.
import 'prismjs/components/prism-dart';
import 'prismjs/components/prism-elixir';
import 'prismjs/components/prism-haskell';
import 'prismjs/components/prism-clojure';
import 'prismjs/components/prism-makefile';
// Gradle build files are Groovy; Prism ships no `gradle` grammar.
import 'prismjs/components/prism-groovy';
