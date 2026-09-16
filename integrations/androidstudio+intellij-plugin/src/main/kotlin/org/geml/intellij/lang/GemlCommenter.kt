package org.geml.intellij.lang

import com.intellij.lang.Commenter

/** `%%` at the start of a line, which is the only comment GEML has. */
class GemlCommenter : Commenter {
  override fun getLineCommentPrefix(): String = "%%"
  override fun getBlockCommentPrefix(): String? = null
  override fun getBlockCommentSuffix(): String? = null
  override fun getCommentedBlockCommentPrefix(): String? = null
  override fun getCommentedBlockCommentSuffix(): String? = null
}
