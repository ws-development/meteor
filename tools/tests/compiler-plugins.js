var _ = require('underscore');
var selftest = require('../tool-testing/selftest.js');
var files = require('../fs/files.js');
import { getUrl } from '../utils/http-helpers.js';
import { sleepMs } from '../utils/utils.js';

var Sandbox = selftest.Sandbox;

var MONGO_LISTENING =
  { stdout: " [initandlisten] waiting for connections on port" };

function startRun(sandbox) {
  var run = sandbox.run();
  run.match("myapp");
  run.matchBeforeExit("Started proxy");
  run.tellMongo(MONGO_LISTENING);
  run.matchBeforeExit("Started MongoDB");
  run.waitSecs(15);
  return run;
};

// Tests the actual cache logic used by coffeescript.
selftest.define("compiler plugin caching - coffee", () => {
  var s = new Sandbox({ fakeMongo: true });

  s.createApp("myapp", "caching-coffee");
  s.cd("myapp");
  // Ask them to print out when they build a file (instead of using it from the
  // cache) as well as when they load cache from disk.
  s.set('METEOR_COFFEESCRIPT_CACHE_DEBUG', 't');
  var run = startRun(s);

  function matchRun(n, files, arch) {
    let text = "CACHE(coffeescript): Ran (#" + n + ") on: " +
      JSON.stringify(files);

    if (arch) {
      text += " " + JSON.stringify([arch]);
    }

    run.match(text);
  }

  // First program built (server or web.browser) compiles everything.
  matchRun(1, [
    '/f1.coffee',
    '/f2.coffee',
    '/f3.coffee',
    '/packages/local-pack/p.coffee'
  ], "web.browser");

  // Second program doesn't need to compile anything because compilation works
  // the same on both programs.
  matchRun(2, [], "web.browser.legacy");
  matchRun(3, []); // os

  // App prints this:
  run.match("Coffeescript X is 2 Y is 1 FromPackage is 4");

  s.write("f2.coffee", "share.Y = 'Y is 3'\n");

  // Only recompiles f2.
  matchRun(4, ["/f2.coffee"], "web.browser");

  // And other program doesn't even need to do f2.
  matchRun(5, [], "web.browser.legacy");
  matchRun(6, []); // os

  // Program prints this:
  run.match("Coffeescript X is 2 Y is 3 FromPackage is 4");

  // Force a rebuild of the local package without actually changing the
  // coffeescript file in it. This should not require us to coffee.compile
  // anything (for either program).
  s.append("packages/local-pack/package.js", "\n// foo\n");

  matchRun(7, [], "web.browser");
  matchRun(8, [], "web.browser.legacy");
  matchRun(9, []); // os

  run.match("Coffeescript X is 2 Y is 3 FromPackage is 4");

  // But writing to the actual source file in the local package should
  // recompile.
  s.write("packages/local-pack/p.coffee", "FromPackage = 'FromPackage is 5'");

  matchRun(10, ["/packages/local-pack/p.coffee"], "web.browser");
  matchRun(11, [], "web.browser.legacy");
  matchRun(12, []); // os

  run.match("Coffeescript X is 2 Y is 3 FromPackage is 5");

  // We never should have loaded cache from disk, since we only made
  // each compiler once and there were no cache files at this point.
  run.forbid('CACHE(coffeescript): Loaded');

  // Kill the run. Change one coffee file and re-run.
  run.stop();
  s.write("f2.coffee", "share.Y = 'Y is edited'\n");
  run = startRun(s);

  // This time there's a cache to load!
  run.match('CACHE(coffeescript): Loaded /packages/local-pack/p.coffee');
  run.match('CACHE(coffeescript): Loaded /f1.coffee');
  run.match('CACHE(coffeescript): Loaded /f3.coffee');
  // And we only need to re-compiler the changed file, even though we restarted.

  matchRun(1, ["/f2.coffee"], "web.browser");
  matchRun(2, [], "web.browser.legacy");
  matchRun(3, []); // os

  run.match('Coffeescript X is 2 Y is edited FromPackage is 5');

  run.stop();
});

// Tests the actual cache logic used by less and stylus.
['less', 'stylus'].forEach((packageName) => {
  const extension = packageName === 'stylus' ? 'styl' : packageName;

  selftest.define("compiler plugin caching - " + packageName, () => {
    var s = new Sandbox({ fakeMongo: true });

    s.createApp("myapp", "caching-" + packageName);
    s.cd("myapp");
    // Ask them to print out when they build a file (instead of using it from
    // the cache) as well as when they load cache from disk.
    s.set(`METEOR_${ packageName.toUpperCase() }_CACHE_DEBUG`, "t");
    var run = startRun(s);

    const cacheMatch = selftest.markStack((message, arch) => {
      run.match(`CACHE(${
        packageName
      }): ${
        message
      }${
        arch ? " " + JSON.stringify([arch]) : ""
      }`);
      run.waitSecs(30);
    });

    function matchRun(n, files, arch) {
      cacheMatch(
        "Ran (#" + n + ") on: " +
          JSON.stringify(files) +
          ((arch && packageName !== "stylus")
           ? " " + JSON.stringify([arch]) : "")
      );
    }

    // First program built (web.browser) compiles everything.
    matchRun(1, [
      // Though files in imports directories are compiled, they are marked
      // as lazy so they will not be loaded unless imported.
      "/imports/dotdot." + extension,
      "/subdir/nested-root." + extension,
      "/top." + extension
    ], "web.browser");
    matchRun(2, [], "web.browser.legacy");
    // There is no render execution in the server program, because it has
    // archMatching:'web'.  We'll see this more clearly when the next call later
    // is "#2" --- we didn't miss a call!
    // App prints this:
    run.waitSecs(15);
    run.match("Hello world");

    // Check that the CSS is what we expect.
    var checkCSS = selftest.markStack((borderStyleMap) => {
      var builtBrowserProgramDir = files.pathJoin(
        s.cwd, '.meteor', 'local', 'build', 'programs', 'web.browser');
      var cssFile = _.find(
        files.readdir(
          files.pathJoin(s.cwd, '.meteor/local/build/programs/web.browser')),
        path => path.match(/\.css$/)
      );
      selftest.expectTrue(cssFile);
      var actual = s.read(
        files.pathJoin('.meteor/local/build/programs/web.browser', cssFile));
      actual = actual.replace(/\s+/g, '');  // simplify whitespace
      var expected = _.map(borderStyleMap, (style, className) => {
        return '.' + className + "{border-style:" + style + ";}";
      }).join('');
      selftest.expectEqual(actual, expected);
    });
    var expectedBorderStyles = {
      el0: "dashed", el1: "dotted", el2: "solid", el3: "groove", el4: "ridge"};
    checkCSS(expectedBorderStyles);

    // Force a rebuild of the local package without actually changing the
    // preprocessor file in it. This should not require us to render anything.
    s.append("packages/local-pack/package.js", "\n// foo\n");
    matchRun(3, [], "web.browser");
    matchRun(4, [], "web.browser.legacy");
    run.waitSecs(15);
    run.match("Hello world");

    function setVariable(variableName, value) {
      switch (packageName) {
      case 'less':
        return `@${ variableName }: ${ value };\n`;
      case 'stylus':
        return `$${ variableName } = ${ value }\n`;
      }
    }
    function importLine(fileWithoutExtension) {
      switch (packageName) {
      case 'less':
        return `@import "${ fileWithoutExtension }.less";\n`;
      case 'stylus':
        return `@import "${ fileWithoutExtension }.styl"\n`;
      }
    }

    // Writing to a single file only re-renders the root that depends on it.
    s.write('packages/local-pack/p.' + extension,
            setVariable('el4-style', 'inset'));
    expectedBorderStyles.el4 = 'inset';
    matchRun(5, [`/top.${ extension }`], "web.browser");
    matchRun(6, [], "web.browser.legacy");
    run.match("Client modified -- refreshing");
    checkCSS(expectedBorderStyles);

    // This works for changing a root too.
    s.write('subdir/nested-root.' + extension,
            '.el0 { border-style: double; }\n');
    expectedBorderStyles.el0 = 'double';
    matchRun(7, [`/subdir/nested-root.${ extension }`], "web.browser");
    matchRun(8, [], "web.browser.legacy");
    run.match("Client modified -- refreshing");
    checkCSS(expectedBorderStyles);

    // Adding a new root works too.
    s.write('yet-another-root.' + extension,
            '.el6 { border-style: solid; }\n');
    expectedBorderStyles.el6 = 'solid';
    matchRun(9, [`/yet-another-root.${ extension }`], "web.browser");
    matchRun(10, [], "web.browser.legacy");
    run.match("Client modified -- refreshing");
    checkCSS(expectedBorderStyles);

    // We never should have loaded cache from disk, since we only made
    // each compiler once and there were no cache files at this point.
    run.forbid('CACHE(${ packageName }): Loaded');

    // Kill the run. Change one file and re-run.
    run.stop();
    s.write('packages/local-pack/p.' + extension,
            setVariable('el4-style', 'double'));
    expectedBorderStyles.el4 = 'double';
    run = startRun(s);

    // This time there's a cache to load!  Note that for
    // MultiFileCachingCompiler we load all the cache entries, even for the
    // not-up-to-date file 'top', because we only key off of filename, not off
    // of cache key.
    cacheMatch('Loaded {}/subdir/nested-root.' + extension);
    cacheMatch('Loaded {}/top.' + extension);
    cacheMatch('Loaded {}/yet-another-root.' + extension);

    matchRun(1, [`/top.${ extension }`], "web.browser");
    matchRun(2, [], "web.browser.legacy");
    run.waitSecs(15);
    run.match('Hello world');
    checkCSS(expectedBorderStyles);

    s.write('bad-import.' + extension, importLine('/foo/bad'));
    run.match('Errors prevented startup');
    switch (packageName) {
    case 'less':
      run.match('bad-import.less:1: Unknown import: /foo/bad.less');
      break;
    case 'stylus':
      run.match('bad-import.styl: Stylus compiler error: bad-import.styl:1');
      run.match('failed to locate @import file /foo/bad.styl');
      break;
    }
    run.match('Waiting for file change');

    run.stop();
  });
});

// Tests that rebuilding a compiler plugin re-instantiates the source processor,
// but other changes don't.
selftest.define("compiler plugin caching - local plugin", function () {
  var s = new Sandbox({ fakeMongo: true });

  s.createApp("myapp", "local-compiler-plugin");
  s.cd("myapp");

  var run = startRun(s);

  // The compiler gets used the first time...
  run.match("PrintmeCompiler invocation 1");
  // ... and the program runs the generated code.
  run.match("PMC: Print out bar");
  run.match("PMC: Print out foo");

  s.write("quux.printme", "And print out quux");
  // PrintmeCompiler gets reused.
  run.match("PrintmeCompiler invocation 2");
  // And the right output prints out
  run.match("PMC: Print out bar");
  run.match("PMC: Print out foo");
  run.match("PMC: And print out quux");

  // Restart meteor; see that the disk cache gets used.
  run.stop();
  run = startRun(s);
  // Disk cache gets us up to 3.
  run.match("PrintmeCompiler invocation 3");
  // And the right output prints out
  run.match("PMC: Print out bar");
  run.match("PMC: Print out foo");
  run.match("PMC: And print out quux");

  // Edit the compiler itself.
  s.write('packages/local-plugin/plugin.js',
          s.read('packages/local-plugin/plugin.js').replace(/PMC/, 'pmc'));
  // New PrintmeCompiler object, and empty disk cache dir.
  run.match("PrintmeCompiler invocation 1");
  // And the right output prints out (lower case now)
  run.match("pmc: Print out bar");
  run.match("pmc: Print out foo");
  run.match("pmc: And print out quux");

  run.stop();
});

// Test error on duplicate compiler plugins.
selftest.define("compiler plugins - duplicate extension", () => {
  const s = new Sandbox({ fakeMongo: true });

  s.createApp("myapp", "duplicate-compiler-extensions");
  s.cd("myapp");

  let run = startRun(s);
  run.match('Errors prevented startup');
  run.match('conflict: two packages');
  run.match('trying to handle *.myext');

  // Fix it by changing one extension.
  s.write('packages/local-plugin/plugin.js',
          s.read('packages/local-plugin/plugin.js').replace('myext', 'xext'));
  run.match('Modified -- restarting');
  run.waitSecs(30);

  run.stop();
});

// Test error when a source file no longer has an active plugin.
selftest.define("compiler plugins - inactive source", () => {
  const s = new Sandbox({ fakeMongo: true });

  // This app depends on the published package 'glasser:uses-sourcish', and
  // contains a local package 'local-plugin'.
  //
  // glasser:uses-sourcish depends on local-plugin and contains a file
  // 'foo.sourcish'. When glasser:uses-sourcish@0.0.1 was published, a local
  // copy of 'local-plugin' had a plugin which called registerCompiler for the
  // extension '*.sourcish', and so 'foo.sourcish' is in the published isopack
  // as a source file. However, the copy of 'local-plugin' currently in the test
  // app contains no plugins. So we hit this weird error.
  s.createApp('myapp', 'uses-published-package-with-inactive-source');
  s.cd('myapp');

  const run = s.run();
  run.match('myapp');
  run.matchBeforeExit('Started proxy');
  run.match('Errors prevented startup');
  run.match('no plugin found for foo.sourcish in glasser:use-sourcish');
  run.match('none is now');
  run.stop();
});

// Test error when the registerCompiler callback throws.
selftest.define("compiler plugins - compiler throws", () => {
  const s = new Sandbox({ fakeMongo: true });

  s.createApp('myapp', 'compiler-plugin-throws-on-instantiate');
  s.cd('myapp');

  const run = s.run('add', 'local-plugin');
  run.matchErr('Errors while adding packages');
  run.matchErr(
    'While running registerCompiler callback in package local-plugin');
  // XXX This is wrong! The path on disk is packages/local-plugin/plugin.js, but
  // at some point we switched to the servePath which is based on the *plugin*'s
  // "package" name.
  run.matchErr(
    /packages\/compilePrintme_plugin\.js:\d+:\d+: Error in my registerCompiler callback!/
  );
  run.expectExit(1);
});

function checkModernAndLegacyUrls(path, test) {
  if (! path.startsWith("/")) {
    path = "/" + path;
  }
  test(getUrl("http://localhost:3000" + path));
  test(getUrl("http://localhost:3000/__browser.legacy" + path));
}

// Test that compiler plugins can add static assets. Also tests `filenames`
// option to registerCompiler.
selftest.define("compiler plugins - compiler addAsset", () => {
  const s = new Sandbox({ fakeMongo: true });

  s.createApp('myapp', 'compiler-plugin-add-asset');
  s.cd('myapp');

  const run = startRun(s);
  // Test server-side asset.
  run.match("extension is null");  // test getExtension -> null
  run.match("Asset says Print out foo");

  // Test client-side asset.
  checkModernAndLegacyUrls("/foo.printme", body => {
    selftest.expectEqual(body, "Print out foo\n");
  });

  run.stop();
});


// Test that a package can have a single file that is both source code and an
// asset
selftest.define("compiler plugins - addAssets", () => {
  const s = new Sandbox({ fakeMongo: true });

  s.createApp('myapp', 'compiler-plugin-asset-and-source');
  s.cd('myapp');

  const run = startRun(s);

  // Test server-side asset.
  run.match("Printing out my own source code!");

  // Test client-side asset.
  checkModernAndLegacyUrls(
    "/packages/asset-and-source/asset-and-source.js",
    body => {
      selftest.expectTrue(
        body.indexOf("Printing out my own source code!") !== -1
      );
    }
  );

  // Test that deprecated API still works (added in 1.2.1 in response to people
  // having trouble upgrading to 1.2)
  s.write("packages/asset-and-source/package.js", `Package.describe({
      name: 'asset-and-source',
      version: '0.0.1'
    });

    Package.onUse(function(api) {
      api.addFiles('asset-and-source.js');
      api.addFiles('asset-and-source.js',
        ['client', 'server'], { isAsset: true });
    });
  `);

  // Test server-side asset.
  run.match("Printing out my own source code!");

  // Test client-side asset.
  checkModernAndLegacyUrls(
    "/packages/asset-and-source/asset-and-source.js",
    body => {
      selftest.expectTrue(
        body.indexOf('Printing out my own source code!') !== -1
      );
    }
  );

  // Test error messages for malformed package files
  s.write("packages/asset-and-source/package.js", `Package.describe({
      name: 'asset-and-source',
      version: '0.0.1'
    });

    Package.onUse(function(api) {
      api.addFiles('asset-and-source.js');
      api.addAssets('asset-and-source.js', ['client', 'server']);
      api.addFiles('asset-and-source.js');
    });
  `);

  run.match(/Duplicate source file/);

  s.write("packages/asset-and-source/package.js", `Package.describe({
      name: 'asset-and-source',
      version: '0.0.1'
    });

    Package.onUse(function(api) {
      api.addFiles('asset-and-source.js');
      api.addAssets('asset-and-source.js', ['client', 'server']);
      api.addAssets('asset-and-source.js', ['client', 'server']);
    });
  `);

  run.match(/Duplicate asset file/);

  s.write("packages/asset-and-source/package.js", `Package.describe({
      name: 'asset-and-source',
      version: '0.0.1'
    });

    Package.onUse(function(api) {
      api.addAssets('asset-and-source.js');
    });
  `);

  run.match(/requires a second argument/);

  run.stop();
});
