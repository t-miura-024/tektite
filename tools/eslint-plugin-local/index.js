/**
 * Local ESLint plugin for tektite.
 * Rules: no-single-use-private-function, no-long-comment-block.
 */

const HEAD_MAX = 400;
const BODY_MAX = 200;
const TRAILING_MAX = 50;

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

const DIRECTIVE_HINTS = ['eslint-', '@ts-', 'c8', 'istanbul', 'prettier', 'oxlint'];

function isDirectiveLine(line) {
  const lower = line.toLowerCase();
  return DIRECTIVE_HINTS.some((hint) => lower.includes(hint));
}

function extractBodyLength(comment) {
  const rawLines = comment.type === 'Line' ? [comment.value] : String(comment.value).split(/\r?\n/);
  let total = 0;
  for (let raw of rawLines) {
    let line = raw.trim();
    if (comment.type === 'Block') {
      line = line.replace(/^\* ?/, '').trim();
    }
    if (line === '' || isDirectiveLine(line)) {
      continue;
    }
    total += Array.from(line).length;
  }
  return total;
}

function isTrailingComment(comment, lines) {
  const startLine = lines[comment.loc.start.line - 1] ?? '';
  const prefix = startLine.slice(0, comment.loc.start.column);
  if (prefix.trim() !== '') {
    return true;
  }
  const endLine = lines[comment.loc.end.line - 1] ?? '';
  const suffix = endLine.slice(comment.loc.end.column);
  return suffix.trim() !== '';
}

function createNoLongCommentBlock(context) {
  const sourceCode = context.sourceCode;
  return {
    'Program:exit'(programNode) {
      const comments = sourceCode.getAllComments();
      if (comments.length === 0) {
        return;
      }
      const sorted = [...comments].sort((a, b) => a.range[0] - b.range[0]);
      const text = sourceCode.text ?? sourceCode.getText();
      const lines = sourceCode.lines ?? text.split(/\r?\n/);
      const trailingFlags = sorted.map((comment) => isTrailingComment(comment, lines));

      const blocks = [];
      const blockIsTrailing = [];
      for (let index = 0; index < sorted.length; index += 1) {
        const comment = sorted[index];
        const trailing = trailingFlags[index];
        const lastBlock = blocks[blocks.length - 1];
        if (!lastBlock || trailing || blockIsTrailing[blocks.length - 1]) {
          blocks.push([comment]);
          blockIsTrailing.push(trailing);
          continue;
        }
        const prev = lastBlock[lastBlock.length - 1];
        if (prev.loc.end.line + 1 < comment.loc.start.line) {
          blocks.push([comment]);
          blockIsTrailing.push(false);
          continue;
        }
        const between = text.slice(prev.range[1], comment.range[0]);
        if (between.trim() !== '') {
          blocks.push([comment]);
          blockIsTrailing.push(false);
          continue;
        }
        lastBlock.push(comment);
      }

      const firstBody = programNode.body[0];
      const firstCodeStart = firstBody ? firstBody.range[0] : Number.POSITIVE_INFINITY;

      blocks.forEach((block) => {
        const last = block[block.length - 1];
        const isHeader = last.range[1] <= firstCodeStart;
        const isTrailing = block.length === 1 && isTrailingComment(block[0], lines);
        const max = isHeader ? HEAD_MAX : isTrailing ? TRAILING_MAX : BODY_MAX;
        const kind = isHeader ? 'Header' : isTrailing ? 'Trailing' : 'Block';
        let actual = 0;
        for (const comment of block) {
          actual += extractBodyLength(comment);
        }
        if (actual <= max) {
          return;
        }
        context.report({
          node: last,
          messageId: 'tooLong',
          data: { kind, actual: String(actual), max: String(max) },
        });
      });
    },
  };
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
    'no-long-comment-block': {
      meta: {
        type: 'suggestion',
        docs: {
          description: 'limit comment block length - header 400, body 200, trailing 50',
        },
        schema: [],
        messages: {
          tooLong: '{{kind}} comment is {{actual}} chars (max {{max}}). Shorten it.',
        },
      },
      create: createNoLongCommentBlock,
    },
  },
};

export default plugin;
