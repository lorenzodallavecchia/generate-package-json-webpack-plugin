/**
 * Created by Paul on 2017-07-02.
 */
const fs = require("fs");
const path = require("path");
const util = require("util");
const { builtinModules } = require("module");

let debugMode = false;

const pluginPrefix = "( Generate Package Json Webpack Plugin ): ";

function GeneratePackageJsonPlugin(
  basePackage = {
    name: "",
    version: "0.0.1",
  }, {
    debug = false,
    extraSourcePackageFilenames = [],
    sourcePackageFilenames = [],
    additionalDependencies = {},
    useInstalledVersions = true,
    resolveContextPaths,
  } = {}
) {
  if (debug) {
    console.log(`GeneratePackageJsonPlugin: Debugging mode activated!`);
    debugMode = true;
  }

  /*
  TODO for future - accept a string and load the base.package.json directly
  if (typeof otherPackageValues === "string") {
    otherPackageValues = JSON.parse(fs.readFileSync(path.join(__dirname, filename)).toString());
  }*/

  const sourcePackagesDependencyVersionMap = {};

  const allSourcePackageFilenames = [...extraSourcePackageFilenames, ...sourcePackageFilenames];

  if (allSourcePackageFilenames.length > 0) {
    logIfDebug(`GPJWP: Received ${allSourcePackageFilenames.length} extra package.json file${allSourcePackageFilenames.length > 1 ? "s" : ""} from which to source versions (later takes preference):`);
    allSourcePackageFilenames.reverse();
    let fileIndex = 1;

    for (const filename of allSourcePackageFilenames) {
      logIfDebug(`${fileIndex++} : ${filename}`);
      const extraSourcePackage = JSON.parse(fs.readFileSync(filename).toString());
      Object.assign(sourcePackagesDependencyVersionMap, extraSourcePackage.dependencies ? extraSourcePackage.dependencies : {});
    }
  }

  logIfDebug(`GPJWP: Final map of dependency versions to be used if encountered in bundle:\n`, sourcePackagesDependencyVersionMap);

  Object.assign(this, {
    basePackage,
    dependencyVersionMap: sourcePackagesDependencyVersionMap,
    additionalDependencies,
    useInstalledVersions,
    resolveContextPaths,
  });
}

function logIfDebug(something, object = "") {
  if (debugMode) {
    if (object) {
      console.log(something, util.inspect(object, { depth: 3 }));
    } else {
      console.log(something);
    }
  }
}

function getNameFromPortableId(raw) {
  let cut = raw.substring(raw.indexOf("\"") + 1, raw.lastIndexOf("\""));

  let slashCount = (cut.match(/\//g) || []).length;

  while ((cut.indexOf("@") === -1 && slashCount > 0) || slashCount > 1) {
    cut = cut.substring(0, cut.lastIndexOf("\/"));
    slashCount -= 1;
  }

  return cut;
}

GeneratePackageJsonPlugin.prototype.apply = function (compiler) {
  const hook = (compilation, callback) => {
    const dependencyTypes = ["dependencies", "devDependencies", "peerDependencies"]

    const modules = Object.assign({}, this.additionalDependencies);

    const getInstalledVersionForModuleName = (moduleName, context) => {
      let modulePackageFile;
      try {
        modulePackageFile = require.resolve(`${moduleName}/package.json`, context ? {
          paths: [context],
        } : this.resolveContextPaths ? {
          paths: this.resolveContextPaths,
        } : undefined);
      } catch (e) {
        logIfDebug(`GPJWP: Ignoring module without a found package.json: ${moduleName}`);
        return undefined;
      }

      let version;
      try {
        version = JSON.parse(fs.readFileSync(modulePackageFile).toString()).version;
      } catch (e) {
        throw new Error(`Can't parse package.json file: ${modulePackageFile}`);
      }

      if (!version) {
        throw new Error(`Missing package.json version: ${modulePackageFile}`);
      }

      return version;
    }

    const processModule = (module) => {
      const portableId = module.portableId ? module.portableId : module.identifier();

      if (portableId.indexOf("external") === -1) {
        logIfDebug(`GPJWP: Found module: ${portableId}`);
        return;
      }

      logIfDebug(`GPJWP: Found external module: ${portableId}`);
      const moduleName = getNameFromPortableId(portableId);

      if (builtinModules.indexOf(moduleName) !== -1) {
        logIfDebug(`GPJWP: Native node.js module detected: ${portableId}`);
        return;
      }

      if (!this.useInstalledVersions) {
        const dependencyVersion = this.dependencyVersionMap[moduleName];
        if (dependencyVersion) {
          modules[moduleName] = dependencyVersion;
        }

        return;
      }

      const context = module.issuer && module.issuer.context;

      modules[moduleName] = getInstalledVersionForModuleName(moduleName, context);
      /*let modulePackageFile;
      try {
        modulePackageFile = require.resolve(`${moduleName}/package.json`, context ? {
          paths: [context],
        } : undefined);
      } catch (e) {
        logIfDebug(`GPJWP: Ignoring module without package.json: ${portableId}`);
        return;
      }

      let version;
      try {
        version = JSON.parse(fs.readFileSync(modulePackageFile).toString()).version;
      } catch (e) {
        throw new Error(`Can't parse package.json file: ${modulePackageFile}`);
      }

      if (!version) {
        throw new Error(`Missing package.json version: ${modulePackageFile}`);
      }

      modules[moduleName] = version;*/
    };

    compilation.chunks.forEach((chunk) => {
      if (typeof chunk.modulesIterable !== "undefined") {
        for (const module of chunk.modulesIterable) {
          processModule(module);
        }
      } else if (typeof chunk.forEachModule !== "undefined") {
        chunk.forEachModule((module) => {
          processModule(module);
        });
      } else {
        for (let i = 0; i < chunk.modules.length; i += 1) {
          const module = chunk.modules[i];
          processModule(module);
        }
      }
    });

    const basePackageValues = Object.assign({}, this.basePackage);

    for (const dependencyType of dependencyTypes) {

      // Overwrite modules or set new module dependencies for those that have been
      // deliberately set in " basePackageValues.[dependencyType] "
      // This mechanism ensures that dependencies declared in the basePackageValues
      // take precedence over the found dependencies
      if (basePackageValues && basePackageValues[dependencyType]) {
        const nonWebpackModuleNames = Object.keys(basePackageValues[dependencyType]);

        for (let k = 0; k < nonWebpackModuleNames.length; k += 1) {
          const moduleName = nonWebpackModuleNames[k];
          let useVersionMap = !this.useInstalledVersions;

          if (basePackageValues[dependencyType] && basePackageValues[dependencyType][moduleName] && basePackageValues[dependencyType][moduleName].length > 0) {
            logIfDebug(`GPJWP: Adding deliberate module in "${dependencyType}" with version set deliberately: ${moduleName} -> ${basePackageValues[dependencyType][moduleName]}`);
            if (dependencyType === "dependencies") {
              modules[moduleName] = basePackageValues[dependencyType][moduleName];
            }
          } else if (this.useInstalledVersions) {
            const version = getInstalledVersionForModuleName(moduleName);
            if (version != null) {
              if (dependencyType !== "dependencies") {
                basePackageValues[dependencyType][moduleName] = version;
                delete modules[moduleName];
              } else {
                modules[moduleName] = version;
              }
            } else {
              console.warn(`${pluginPrefix}Couldn't find installed version for module "${moduleName}" - falling back to extra source package version map (if provided)`);
              useVersionMap = true;
            }
          }

          if (useVersionMap) {
            if (this.dependencyVersionMap[moduleName] != null) {
              logIfDebug(`GPJWP: Adding deliberate module in "${dependencyType}" with version found in sources: ${moduleName} -> ${this.dependencyVersionMap[moduleName]}`);
              if (dependencyType !== "dependencies") {
                basePackageValues[dependencyType][moduleName] = this.dependencyVersionMap[moduleName];
                delete modules[moduleName];
              } else {
                modules[moduleName] = this.dependencyVersionMap[moduleName];
              }
            } else {
              console.warn(`${pluginPrefix}You have set a module in "${dependencyType}" to be included deliberately with name: "${moduleName}" - but there is no version specified in any source files, or found to be installed (if you used the option useInstalledVersions)!`);
            }
          }
        }
      }
    }

    logIfDebug(`GPJWP: Modules to be used in generated package.json`, modules);

    const finalPackageValues = Object.assign({}, basePackageValues, { dependencies: orderKeys(modules) });
    const json = JSON.stringify(finalPackageValues, this.replacer ? this.replacer : null, this.space ? this.space : 2);

    compilation.assets['package.json'] = {
      source: function () {
        return json;
      },
      size: function () {
        return json.length;
      }
    };

    callback();
  };

  if (typeof compiler.hooks !== "undefined") {
    compiler.hooks.emit.tapAsync("GeneratePackageJsonPlugin", hook);
  } else {
    compiler.plugin('emit', hook);
  }
};

function orderKeys(obj) {
  const keys = Object.keys(obj).sort(function keyOrder(k1, k2) {
    if (k1 < k2) return -1;
    else if (k1 > k2) return +1;
    else return 0;
  });

  let i, after = {};
  for (i = 0; i < keys.length; i++) {
    after[keys[i]] = obj[keys[i]];
    delete obj[keys[i]];
  }

  for (i = 0; i < keys.length; i++) {
    obj[keys[i]] = after[keys[i]];
  }
  return obj;
}

module.exports = GeneratePackageJsonPlugin;
