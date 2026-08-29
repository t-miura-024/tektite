/**
 * Local ESLint plugin for tektite.
 * Rule: no-single-use-private-function
 *
 * - 対象: export されていないモジュール内関数（トップレベル/ネスト問わず、FunctionDeclaration / const foo = () => / function式）のうち、同一スコープ内で1回だけ参照されるもの
 * - 除外: 再帰（自己参照を含む）、exportされたもの、PascalCase/use*（Reactコンポーネント/hooks）
 * - スコープ: 全スコープ（module, function, block）
 */

/**
 * @param {import('eslint').Rule.RuleContext} context
 */
function createNoSingleUsePrivateFunction(context) {
  const sourceCode = context.sourceCode;
  let programNode = null;

  return {
    Program(node) {
      programNode = node;
    },
    'Program:exit'() {
      if (!programNode) {
        return;
      }
      const globalScope = sourceCode.getScope(programNode);
      // 全スコープを再帰的に収集（module, function, block など）
      const allScopes = [];
      const collect = (scope) => {
        allScopes.push(scope);
        for (const child of scope.childScopes) {
          collect(child);
        }
      };
      collect(globalScope);

      for (const scope of allScopes) {
        for (const variable of scope.variables) {
          // variable.defs: Definition[]
          if (variable.defs.length === 0) {
            continue;
          }
          const def = variable.defs[0];
          if (!def) {
            continue;
          }

          // Only consider function definitions at top level
          // def.type can be 'FunctionName' (for function declaration) or 'Variable' (for const foo = () =>)
          const isFunctionName = def.type === 'FunctionName';
          const isVariable = def.type === 'Variable';

          let isFunction = false;
          let defNode = null;
          let isExported = false;

          if (isFunctionName) {
            // function foo() {}
            // def.node is FunctionDeclaration
            const funcNode = def.node;
            defNode = funcNode;
            // Check if it's a function declaration
            if (funcNode.type !== 'FunctionDeclaration') {
              continue;
            }
            isFunction = true;
            // Check export: parent is ExportNamedDeclaration or ExportDefaultDeclaration
            const parent = funcNode.parent;
            if (
              parent &&
              (parent.type === 'ExportNamedDeclaration' ||
                parent.type === 'ExportDefaultDeclaration')
            ) {
              isExported = true;
            }
          } else if (isVariable) {
            // const foo = () => {} or const foo = function() {}
            // def.node is VariableDeclarator
            const declarator = def.node;
            defNode = declarator;
            if (declarator.type !== 'VariableDeclarator') {
              continue;
            }
            const init = declarator.init;
            if (
              !init ||
              (init.type !== 'ArrowFunctionExpression' &&
                init.type !== 'FunctionExpression' &&
                init.type !== 'CallExpression') // for handling some edge like Effect wrappers - but we treat CallExpression not as function
            ) {
              continue;
            }
            // Only arrow/function expression
            if (init.type === 'CallExpression') {
              continue;
            }
            isFunction = true;
            // Check export: VariableDeclaration -> ExportNamedDeclaration
            const varDecl = declarator.parent;
            const maybeExport = varDecl?.parent;
            if (
              maybeExport &&
              (maybeExport.type === 'ExportNamedDeclaration' ||
                maybeExport.type === 'ExportDefaultDeclaration')
            ) {
              isExported = true;
            }
          } else {
            continue;
          }

          if (!isFunction || isExported) {
            continue;
          }

          // React コンポーネント (PascalCase) と hooks (use*) は抽出が慣習的に可読性に寄与するため除外
          if (/^[A-Z]/.test(variable.name) || /^use[A-Z]/.test(variable.name)) {
            continue;
          }

          // Count references (excluding definition)
          // variable.references includes all references; variable.defs[0] is definition
          // We need to filter references that are not the definition's initializer self
          // Count read references
          const references = variable.references;
          // Filter out the reference that is the definition itself if counted
          // In eslint scope, the definition's identifier is not counted as reference, only usages are.
          // So references.length is number of usages.

          // Detect recursion: if any reference is inside the function node itself
          let hasRecursiveReference = false;
          let externalReferenceCount = 0;
          for (const ref of references) {
            const idNode = ref.identifier;
            // Check if identifier is inside defNode's function body
            // For FunctionDeclaration, check if idNode is inside funcNode
            // For Variable, check if inside init
            let funcBodyNode = null;
            if (isFunctionName) {
              funcBodyNode = defNode;
            } else if (isVariable) {
              funcBodyNode = defNode.init;
            }
            if (funcBodyNode && isNodeInside(idNode, funcBodyNode)) {
              hasRecursiveReference = true;
              // Don't count recursive as external, but we will exclude entire variable if recursive
              continue;
            }
            externalReferenceCount += 1;
          }

          if (hasRecursiveReference) {
            continue;
          }

          if (externalReferenceCount === 1) {
            // Report at definition identifier
            const id = variable.identifiers[0] ?? def.name;
            if (id) {
              context.report({
                node: id,
                messageId: 'singleUse',
                data: { name: variable.name },
              });
            }
          }
        }
      }
    },
  };
}

function isNodeInside(child, parent) {
  if (!child || !parent || !child.range || !parent.range) {
    return false;
  }
  return child.range[0] >= parent.range[0] && child.range[1] <= parent.range[1];
}

const plugin = {
  rules: {
    'no-single-use-private-function': {
      meta: {
        type: 'suggestion',
        docs: {
          description: 'disallow single-use private functions - inline them for readability',
        },
        schema: [],
        messages: {
          singleUse:
            "Private function '{{name}}' is used only once. Inline it instead of creating a separate function.",
        },
      },
      create: createNoSingleUsePrivateFunction,
    },
  },
};

export default plugin;
