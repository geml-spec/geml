package org.geml.intellij.lang

import com.intellij.extapi.psi.ASTWrapperPsiElement
import com.intellij.extapi.psi.PsiFileBase
import com.intellij.lang.ASTNode
import com.intellij.lang.ParserDefinition
import com.intellij.lang.PsiParser
import com.intellij.openapi.fileTypes.FileType
import com.intellij.openapi.project.Project
import com.intellij.psi.FileViewProvider
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiFile
import com.intellij.psi.tree.IFileElementType
import com.intellij.psi.tree.TokenSet
import org.geml.intellij.GemlFileType
import org.geml.intellij.GemlLanguage

class GemlFile(viewProvider: FileViewProvider) : PsiFileBase(viewProvider, GemlLanguage) {
  override fun getFileType(): FileType = GemlFileType
  override fun toString(): String = "GEML file"
}

/**
 * A deliberately flat tree: one node holding every token.
 *
 * The platform wants a ParserDefinition before it will give a language an
 * editor, a structure view or a folding model. It does NOT follow that this
 * plugin should parse GEML — that job belongs to the reference implementation,
 * and a second one living in an editor is exactly the drift this format exists
 * to avoid. So the "parser" here spends the lexer's tokens into a single node,
 * and everything that needs real structure asks `geml list --json` instead (see
 * cli/GemlIndex).
 */
class GemlParserDefinition : ParserDefinition {
  override fun createLexer(project: Project?): GemlLexer = GemlLexer()

  override fun createParser(project: Project?): PsiParser = PsiParser { root, builder ->
    val mark = builder.mark()
    while (!builder.eof()) builder.advanceLexer()
    mark.done(root)
    builder.treeBuilt
  }

  override fun getFileNodeType(): IFileElementType = FILE
  override fun getCommentTokens(): TokenSet = COMMENTS
  override fun getStringLiteralElements(): TokenSet = TokenSet.EMPTY
  override fun createElement(node: ASTNode): PsiElement = ASTWrapperPsiElement(node)
  override fun createFile(viewProvider: FileViewProvider): PsiFile = GemlFile(viewProvider)

  companion object {
    val FILE = IFileElementType(GemlLanguage)
    val COMMENTS: TokenSet = TokenSet.create(GemlTokens.COMMENT)
  }
}
