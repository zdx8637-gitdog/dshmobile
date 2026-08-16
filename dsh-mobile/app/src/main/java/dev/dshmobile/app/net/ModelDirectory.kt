package dev.dshmobile.app.net

import kotlinx.serialization.Serializable

/** session.models 响应。 */
@Serializable
data class ModelDirectory(
    val current: ModelSelection,
    val routable: Boolean,
    val groups: List<ModelProviderGroup> = emptyList(),
    val failures: List<ModelCatalogFailure> = emptyList(),
)

@Serializable
data class ModelSelection(
    val provider: String,
    val model: String,
    val reasoningEffort: String? = null,
)

@Serializable
data class ModelProviderGroup(
    val id: String,
    val name: String,
    val models: List<ModelCatalogModel> = emptyList(),
)

@Serializable
data class ModelCatalogModel(
    val id: String,
    val name: String,
    val description: String? = null,
    val reasoning: ModelReasoning? = null,
)

@Serializable
data class ModelReasoning(
    val efforts: List<ModelReasoningEffort> = emptyList(),
    val defaultEffort: String? = null,
)

@Serializable
data class ModelReasoningEffort(
    val id: String,
    val name: String,
    val description: String? = null,
)

@Serializable
data class ModelCatalogFailure(
    val id: String,
    val name: String,
    val message: String,
)
